import { config } from '../config.js';
import { CIDBHtmlConnector } from './connector.js';
import { FileFixtureConnector } from './fileConnector.js';
import { CIDBJsonConnector } from './jsonConnector.js';
import { TenderSourceConnector } from './types.js';

/** True when a source URL points at the machine-readable feed rather than HTML. */
export function isJsonFeedUrl(url: string): boolean {
  const withoutQuery = url.split('?')[0].split('#')[0];
  return /\.json$/i.test(withoutQuery);
}

/**
 * Build the active CIDB connector from configuration.
 *
 * - `CIDB_SOURCE_URL=https://www.cidb.org.za/tenders.json` (production default)
 *   → JSON feed connector: the data the public listing page renders client-side.
 * - `CIDB_SOURCE_URL=https://…/current-tenders/` → HTML connector, for
 *   server-rendered listings (the current page is JavaScript-rendered, so its
 *   served table is empty and this connector reports SOURCE_STRUCTURE_CHANGED).
 * - `CIDB_SOURCE_URL=file:./path/to/listing.html|.json` (local testing) →
 *   offline fixture connector running the identical pipeline on either format.
 */
export function createConnector(): TenderSourceConnector {
  if (config.CIDB_SOURCE_URL.startsWith('file:')) {
    return new FileFixtureConnector(config.CIDB_SOURCE_URL, { closingSoonDays: config.CLOSING_SOON_DAYS });
  }
  if (isJsonFeedUrl(config.CIDB_SOURCE_URL)) {
    return new CIDBJsonConnector();
  }
  return new CIDBHtmlConnector();
}
