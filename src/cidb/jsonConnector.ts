import { config } from '../config.js';
import { NormalizedTender } from '../schemas/tender.js';
import { childLogger } from '../utils/logging.js';
import {
  CidbFeedEntry,
  dedupeFeedEntries,
  extractFeedEntries,
  feedEntryKey,
  feedPageUrl,
  parseFeedEntries,
  probeTendersJson,
} from './jsonFeed.js';
import { normalizeParsedTender } from './normalizer.js';
import { fetchJson } from './scraper.js';
import {
  ConnectorHealth,
  DiscoveredRecord,
  ParsedTender,
  TenderSourceConnector,
} from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FeedPageResult {
  page: number;
  url: string;
  rows: number;
  newRows: number;
  bytes: number;
}

export interface FeedPagesResult {
  /** Every distinct entry across all pages, in source order. */
  entries: CidbFeedEntry[];
  pages: FeedPageResult[];
  /** Total the source declares (`tender_count`), when it declares one. */
  declaredTotal: number | null;
  warnings: string[];
}

/** Injectable transport — tests stub this instead of hitting the network. */
export type FeedFetcher = (url: string) => Promise<{ json: unknown; raw: string }>;

export interface FetchFeedPagesOptions {
  sourceUrl: string;
  pageSize?: number;
  maxPages?: number;
  /** Polite delay between page requests. */
  delayMs?: number;
  fetch?: FeedFetcher;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Page through the CIDB feed until every record it declares has been seen.
 *
 * The listing page requests `tenders.json` with `{page, limit, search_item,
 * region, status}` and builds its pager from `tender_count`, so a single
 * unparameterized request returns only the first page (25 of 33 at the time of
 * writing). This walks the pages, merges them on the feed's own identity
 * (`tender_ID`) and stops as soon as a page adds nothing new — which is also
 * what makes it safe if the source ever starts ignoring the paging parameters.
 */
export async function fetchFeedPages(options: FetchFeedPagesOptions): Promise<FeedPagesResult> {
  const pageSize = options.pageSize ?? config.CIDB_FEED_PAGE_SIZE;
  const maxPages = options.maxPages ?? config.CIDB_FEED_MAX_PAGES;
  const delayMs = options.delayMs ?? config.REQUEST_DELAY_MS;
  const getJson =
    options.fetch ??
    (async (url: string) => {
      const { json, raw } = await fetchJson(url);
      return { json, raw };
    });
  const log = options.log ?? ((): void => {});

  const entries: CidbFeedEntry[] = [];
  const seen = new Set<string>();
  const pages: FeedPageResult[] = [];
  const warnings: string[] = [];
  let declaredTotal: number | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = feedPageUrl(options.sourceUrl, { page, limit: pageSize });
    const { json, raw } = await getJson(url);

    const probe = probeTendersJson(json);
    declaredTotal = probe.declaredTotal ?? declaredTotal;
    const rows = extractFeedEntries(json);

    let newRows = 0;
    for (const row of rows) {
      const key = feedEntryKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(row);
      newRows += 1;
    }

    pages.push({ page, url, rows: rows.length, newRows, bytes: raw.length });
    log(`Feed page ${page}: ${rows.length} rows (${newRows} new)`, {
      event: 'FEED_PAGE',
      page,
      url,
      rows: rows.length,
      newRows,
      total: entries.length,
      declaredTotal,
    });

    if (rows.length === 0) break;

    if (newRows === 0) {
      // Same rows again: the source ignored page/limit. Keep what we have and
      // say so loudly rather than looping or silently under-reporting.
      warnings.push(
        `feed repeated page ${page} with no new entries (paging parameters ignored?): ` +
          `${entries.length} distinct records collected, tender_count declares ${declaredTotal ?? 'n/a'}`,
      );
      break;
    }

    if (declaredTotal !== null && entries.length >= declaredTotal) break;

    if (page === maxPages) {
      warnings.push(
        `stopped at CIDB_FEED_MAX_PAGES=${maxPages} with ${entries.length} of ${declaredTotal ?? '?'} declared records`,
      );
      break;
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return { entries: dedupeFeedEntries(entries), pages, declaredTotal, warnings };
}

/**
 * Connector for the CIDB machine-readable tender feed (`tenders.json`).
 *
 * This is the source the public current-tenders page itself renders from, so it
 * is the authoritative dataset: it carries every record with `realstatus`,
 * per-document timestamps and document links embedded in the description HTML.
 * The feed is paginated server-side; `fetchFeedPages` walks all of it.
 *
 * Selected when `CIDB_SOURCE_URL` points at a `.json` feed; `CIDBHtmlConnector`
 * remains available for server-rendered listings and `FileFixtureConnector`
 * replays either format offline.
 */
export class CIDBJsonConnector implements TenderSourceConnector {
  readonly source = 'CIDB';
  readonly sourceUrl: string;
  /** Human-facing page records are attributed to (the feed URL is machine-only). */
  readonly attributionUrl: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly delayMs: number;
  private readonly closingSoonDays: number;
  private readonly fetcher?: FeedFetcher;
  private readonly log = childLogger({ connector: 'CIDBJsonConnector' });

  constructor(
    options: {
      sourceUrl?: string;
      attributionUrl?: string;
      pageSize?: number;
      maxPages?: number;
      delayMs?: number;
      closingSoonDays?: number;
      /** Injectable transport (tests); defaults to the polite HTTP scraper. */
      fetcher?: FeedFetcher;
    } = {},
  ) {
    this.sourceUrl = options.sourceUrl ?? config.CIDB_SOURCE_URL;
    this.attributionUrl = options.attributionUrl ?? config.CIDB_LISTING_URL;
    this.pageSize = options.pageSize ?? config.CIDB_FEED_PAGE_SIZE;
    this.maxPages = options.maxPages ?? config.CIDB_FEED_MAX_PAGES;
    this.delayMs = options.delayMs ?? config.REQUEST_DELAY_MS;
    this.closingSoonDays = options.closingSoonDays ?? config.CLOSING_SOON_DAYS;
    this.fetcher = options.fetcher;
  }

  async discover(): Promise<DiscoveredRecord[]> {
    this.log.info({ event: 'DISCOVER_STARTED', url: this.sourceUrl }, 'Discovering CIDB records from the JSON feed');
    const feed = await fetchFeedPages({
      sourceUrl: this.sourceUrl,
      pageSize: this.pageSize,
      maxPages: this.maxPages,
      delayMs: this.delayMs,
      fetch: this.fetcher,
      log: (message, meta) => this.log.debug(meta, message),
    });

    if (feed.entries.length === 0) {
      // Fail loudly: an empty feed is a source problem, never a real "no tenders".
      throw new Error(
        `SOURCE_STRUCTURE_CHANGED: the CIDB feed at ${this.sourceUrl} contained no tender entries ` +
          `(expected { tm_tenders: [...] })`,
      );
    }

    for (const warning of feed.warnings) this.log.warn({ event: 'FEED_WARNING', warning }, warning);

    const parsed = parseFeedEntries(feed.entries, this.sourceUrl, this.attributionUrl);
    this.log.info(
      {
        event: 'DISCOVER_COMPLETED',
        pages: feed.pages.length,
        entries: feed.entries.length,
        parsed: parsed.length,
        declaredTotal: feed.declaredTotal,
        warnings: feed.warnings,
      },
      `Feed returned ${feed.entries.length} entries over ${feed.pages.length} page(s) ` +
        `(${parsed.length} usable; source declares ${feed.declaredTotal ?? 'n/a'})`,
    );

    return parsed.map((record) => ({
      sourceRecordId: record.bidNumber,
      sourceUrl: this.attributionUrl,
      payload: { ...record },
    }));
  }

  async fetch(record: DiscoveredRecord): Promise<DiscoveredRecord> {
    // The feed carries the complete record; no per-tender detail fetch exists.
    return record;
  }

  async parse(record: DiscoveredRecord): Promise<ParsedTender> {
    const payload = record.payload as unknown as ParsedTender;
    return {
      bidNumber: payload.bidNumber ?? null,
      title: payload.title ?? null,
      description: payload.description ?? null,
      organisation: payload.organisation ?? null,
      publishedDate: payload.publishedDate ?? null,
      closingDate: payload.closingDate ?? null,
      locationText: payload.locationText ?? null,
      documents: Array.isArray(payload.documents) ? payload.documents : [],
      sourceUrl: record.sourceUrl,
      extra: (payload.extra as Record<string, unknown>) ?? {},
    };
  }

  async normalize(parsed: ParsedTender): Promise<NormalizedTender> {
    return normalizeParsedTender(parsed, { closingSoonDays: this.closingSoonDays });
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now();
    try {
      // One page is enough to prove reachability + structure; a full walk is a sync.
      const healthUrl = feedPageUrl(this.sourceUrl, { page: 1, limit: this.pageSize });
      const json = this.fetcher
        ? (await this.fetcher(healthUrl)).json
        : (await fetchJson(healthUrl, { maxRetries: 0 })).json;
      const probe = probeTendersJson(json);
      const detail = probe.found
        ? `JSON feed OK (${probe.rowCount} entries on page 1, ${probe.declaredTotal ?? 'n/a'} declared)`
        : 'JSON feed reachable but contained no tender entries';
      return { reachable: probe.found, latencyMs: Date.now() - start, detail };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
