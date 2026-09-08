import { config } from '../config.js';
import { CIDBHtmlConnector } from './connector.js';
import { FileFixtureConnector } from './fileConnector.js';
import { TenderSourceConnector } from './types.js';

/**
 * Build the active CIDB connector from configuration.
 *
 * - `CIDB_SOURCE_URL=https://…` (production) → live HTML connector.
 * - `CIDB_SOURCE_URL=file:./path/to/listing.html` (local testing) →
 *   offline fixture connector running the identical pipeline.
 */
export function createConnector(): TenderSourceConnector {
  if (config.CIDB_SOURCE_URL.startsWith('file:')) {
    return new FileFixtureConnector(config.CIDB_SOURCE_URL, { closingSoonDays: config.CLOSING_SOON_DAYS });
  }
  return new CIDBHtmlConnector();
}
