import { config } from '../config.js';
import { NormalizedTender } from '../schemas/tender.js';
import { childLogger } from '../utils/logging.js';
import { parseTendersJson, probeTendersJson } from './jsonFeed.js';
import { normalizeParsedTender } from './normalizer.js';
import { fetchJson } from './scraper.js';
import {
  ConnectorHealth,
  DiscoveredRecord,
  ParsedTender,
  TenderSourceConnector,
} from './types.js';

/**
 * Connector for the CIDB machine-readable tender feed (`tenders.json`).
 *
 * This is the source the public current-tenders page itself renders from, so it
 * is the authoritative dataset: one request returns every record (the site's
 * pagination is client-side) together with `realstatus`, per-document timestamps
 * and document links embedded in the description HTML.
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
  private readonly closingSoonDays: number;
  private readonly log = childLogger({ connector: 'CIDBJsonConnector' });

  constructor(options: { sourceUrl?: string; attributionUrl?: string; closingSoonDays?: number } = {}) {
    this.sourceUrl = options.sourceUrl ?? config.CIDB_SOURCE_URL;
    this.attributionUrl = options.attributionUrl ?? config.CIDB_LISTING_URL;
    this.closingSoonDays = options.closingSoonDays ?? config.CLOSING_SOON_DAYS;
  }

  async discover(): Promise<DiscoveredRecord[]> {
    this.log.info({ event: 'DISCOVER_STARTED', url: this.sourceUrl }, 'Discovering CIDB records from the JSON feed');
    const { json } = await fetchJson(this.sourceUrl);
    const probe = probeTendersJson(json);
    if (!probe.found) {
      // Fail loudly: an empty feed is a source problem, never a real "no tenders".
      throw new Error(
        `SOURCE_STRUCTURE_CHANGED: the CIDB feed at ${this.sourceUrl} contained no tender entries ` +
          `(expected { tm_tenders: [...] })`,
      );
    }
    const parsed = parseTendersJson(json, this.sourceUrl, this.attributionUrl);
    this.log.info(
      { event: 'DISCOVER_COMPLETED', entries: probe.rowCount, parsed: parsed.length, declaredCount: probe.declaredCount },
      `Feed returned ${probe.rowCount} entries (${parsed.length} usable)`,
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
      const { json } = await fetchJson(this.sourceUrl, { maxRetries: 0 });
      const probe = probeTendersJson(json);
      return {
        reachable: probe.found,
        latencyMs: Date.now() - start,
        detail: probe.found
          ? `JSON feed OK (${probe.rowCount} entries)`
          : 'JSON feed reachable but contained no tender entries',
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
