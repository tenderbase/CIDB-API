import { config } from '../config.js';
import { NormalizedTender } from '../schemas/tender.js';
import { childLogger } from '../utils/logging.js';
import { normalizeParsedTender } from './normalizer.js';
import { parseCurrentTendersHtml, probeTenderTable } from './parser.js';
import { fetchHtml } from './scraper.js';
import {
  ConnectorHealth,
  DiscoveredRecord,
  ParsedTender,
  TenderSourceConnector,
} from './types.js';

/**
 * HTML connector for the CIDB current-tenders listing.
 *
 * Listing pages are self-contained (no per-tender detail pages exist on
 * this source), so `fetch()` is a pass-through. If CIDB later publishes an
 * official API/feed, add a `CIDBOfficialApiConnector` implementing
 * `TenderSourceConnector` and swap it in the sync service — no public API
 * or database changes required.
 */
export class CIDBHtmlConnector implements TenderSourceConnector {
  readonly source = 'CIDB';
  readonly sourceUrl: string;
  private readonly closingSoonDays: number;
  private readonly log = childLogger({ connector: 'CIDBHtmlConnector' });

  constructor(options: { sourceUrl?: string; closingSoonDays?: number } = {}) {
    this.sourceUrl = options.sourceUrl ?? config.CIDB_SOURCE_URL;
    this.closingSoonDays = options.closingSoonDays ?? config.CLOSING_SOON_DAYS;
  }

  async discover(): Promise<DiscoveredRecord[]> {
    this.log.info({ event: 'DISCOVER_STARTED', url: this.sourceUrl }, 'Discovering CIDB tender records');
    const { html } = await fetchHtml(this.sourceUrl);
    const parsed = parseCurrentTendersHtml(html, this.sourceUrl);
    return parsed.map((record, index) => ({
      sourceRecordId: record.bidNumber,
      sourceUrl: this.sourceUrl,
      payload: { ...record, rowIndex: index },
    }));
  }

  async fetch(record: DiscoveredRecord): Promise<DiscoveredRecord> {
    // The listing carries the full record; no detail fetch needed (v1).
    return record;
  }

  async parse(record: DiscoveredRecord): Promise<ParsedTender> {
    const payload = record.payload as unknown as ParsedTender & { rowIndex?: number };
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
      const { html } = await fetchHtml(this.sourceUrl, { maxRetries: 0 });
      const probe = probeTenderTable(html);
      return {
        reachable: probe.found,
        latencyMs: Date.now() - start,
        detail: probe.found
          ? `tender table OK (${probe.rowCount} rows)`
          : 'tender table not found in source HTML',
      };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
