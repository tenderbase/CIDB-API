/**
 * CIDB connector type model.
 *
 * The connector abstraction keeps CIDB ingestion an implementation detail:
 * the public REST API and the database model never depend on how records
 * were discovered. A future `CIDBOfficialApiConnector` can replace the
 * HTML connector without touching anything downstream.
 */

/** A raw record discovered from a CIDB source listing. */
export interface DiscoveredRecord {
  /** Stable identifier from the source when available (else null). */
  sourceRecordId: string | null;
  /** URL of the listing/detail page the record came from. */
  sourceUrl: string;
  /** Raw extracted fields (shape depends on the connector). */
  payload: Record<string, unknown>;
}

/** A raw document link discovered alongside a record. */
export interface DiscoveredDocument {
  name: string;
  url: string;
  /** Raw link text / label from the source. */
  label: string | null;
}

/** Structured intermediate output of the parse stage. */
export interface ParsedTender {
  bidNumber: string | null;
  title: string | null;
  description: string | null;
  organisation: string | null;
  publishedDate: string | null;
  closingDate: string | null;
  locationText: string | null;
  documents: DiscoveredDocument[];
  sourceUrl: string;
  /** Anything else the connector extracted (kept for rawData/audit). */
  extra: Record<string, unknown>;
}

export interface ConnectorHealth {
  reachable: boolean;
  latencyMs: number | null;
  detail?: string;
}

/**
 * Connector contract. Every CIDB source (current/awarded/archived/cancelled
 * tenders, or a future official API) implements this interface.
 */
export interface TenderSourceConnector {
  readonly source: string;
  readonly sourceUrl: string;

  /** Discover raw records from the source listing. */
  discover(): Promise<DiscoveredRecord[]>;

  /** Fetch additional detail for a single record (no-op when the listing is complete). */
  fetch(record: DiscoveredRecord): Promise<DiscoveredRecord>;

  /** Parse a raw record into structured intermediate data. */
  parse(record: DiscoveredRecord): Promise<ParsedTender>;

  /** Normalize parsed data into the validated Tender schema. */
  normalize(parsed: ParsedTender): Promise<import('../schemas/tender.js').NormalizedTender>;

  /** Check that the upstream source is reachable and structurally sane. */
  healthCheck(): Promise<ConnectorHealth>;
}

export class SourceStructureChangedError extends Error {
  readonly code = 'SOURCE_STRUCTURE_CHANGED';
  constructor(message: string) {
    super(message);
    this.name = 'SourceStructureChangedError';
  }
}

export class SourceRequestError extends Error {
  readonly code = 'SOURCE_REQUEST_FAILED';
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SourceRequestError';
    this.status = status;
  }
}
