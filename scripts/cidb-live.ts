/**
 * Live CIDB source probe (manual, never part of CI).
 *
 * Fetches the real CIDB current-tenders page, parses it and prints a
 * summary — use it to verify selectors still match the live site:
 *
 *   npm run test:cidb-live
 */
import { CIDBHtmlConnector } from '../src/cidb/connector.js';
import { fetchHtml } from '../src/cidb/scraper.js';
import { probeTenderTable } from '../src/cidb/parser.js';

async function main(): Promise<void> {
  const url = process.env.CIDB_SOURCE_URL ?? 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
  console.log(`Probing ${url} ...\n`);

  const started = Date.now();
  const { html, attempts } = await fetchHtml(url);
  console.log(`Fetched ${(html.length / 1024).toFixed(1)} KB in ${Date.now() - started}ms (${attempts} attempt(s))`);

  const probe = probeTenderTable(html);
  console.log(`Table found: ${probe.found} | columns: ${probe.columns.join(', ') || 'none'} | rows: ${probe.rowCount}`);
  if (!probe.found) {
    console.error('\nFAIL: tender table not detected — SOURCE_STRUCTURE_CHANGED');
    process.exit(1);
  }

  const connector = new CIDBHtmlConnector({ sourceUrl: url });
  const records = await connector.discover();
  console.log(`Discovered records: ${records.length}`);

  const sample = records.slice(0, 3);
  for (const record of sample) {
    const parsed = await connector.parse(record);
    const normalized = await connector.normalize(parsed);
    console.log(`\n- ${normalized.externalId}`);
    console.log(`  bid:       ${normalized.bidNumber}`);
    console.log(`  title:     ${normalized.title.slice(0, 100)}`);
    console.log(`  published: ${normalized.publishedDate?.toISOString() ?? 'null'}  status: ${normalized.status}`);
    console.log(`  docs:      ${normalized.documents.length} (${normalized.documents.map((d) => d.documentType).join(', ')})`);
    void parsed;
  }

  console.log('\nOK: live source parse succeeded');
}

main().catch((error) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
