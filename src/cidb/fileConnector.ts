import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NormalizedTender } from '../schemas/tender.js';
import { childLogger } from '../utils/logging.js';
import { normalizeParsedTender } from './normalizer.js';
import { parseCurrentTendersHtml, probeTenderTable } from './parser.js';
import {
  ConnectorHealth,
  DiscoveredRecord,
  ParsedTender,
  SourceRequestError,
  TenderSourceConnector,
} from './types.js';

/**
 * Offline connector that ingests a saved CIDB listing HTML file instead of
 * the live website. Selected when `CIDB_SOURCE_URL` starts with `file:`.
 *
 * Intended for LOCAL TESTING AND DEVELOPMENT ONLY — it runs the exact same
 * parser, normalizer, validation and sync pipeline as the live HTML
 * connector, just with a frozen input. Production always uses the live
 * `CIDBHtmlConnector`.
 */
export class FileFixtureConnector implements TenderSourceConnector {
  readonly source = 'CIDB';
  readonly sourceUrl: string;
  private readonly filePath: string;
  private readonly closingSoonDays: number;
  private readonly log = childLogger({ connector: 'FileFixtureConnector' });

  constructor(fileUrl: string, options: { closingSoonDays?: number } = {}) {
    const path = fileUrl.startsWith('file:') ? fileUrl.slice('file:'.length) : fileUrl;
    this.filePath = resolve(process.cwd(), path);
    // Records keep the canonical CIDB listing URL as their source URL so
    // attribution stays correct even in offline mode.
    this.sourceUrl = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
    this.closingSoonDays = options.closingSoonDays ?? 7;
  }

  private readHtml(): string {
    try {
      return readFileSync(this.filePath, 'utf8');
    } catch (error) {
      throw new SourceRequestError(
        `Could not read CIDB fixture file ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async discover(): Promise<DiscoveredRecord[]> {
    this.log.info({ event: 'DISCOVER_STARTED', file: this.filePath }, 'Discovering CIDB records from fixture file');
    const parsed = parseCurrentTendersHtml(this.readHtml(), this.sourceUrl);
    return parsed.map((record, index) => ({
      sourceRecordId: record.bidNumber,
      sourceUrl: this.sourceUrl,
      payload: { ...record, rowIndex: index },
    }));
  }

  async fetch(record: DiscoveredRecord): Promise<DiscoveredRecord> {
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
      const probe = probeTenderTable(this.readHtml());
      return {
        reachable: probe.found,
        latencyMs: Date.now() - start,
        detail: probe.found
          ? `fixture table OK (${probe.rowCount} rows): ${this.filePath}`
          : `tender table not found in fixture: ${this.filePath}`,
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
