/**
 * Live CIDB source probe (manual, never part of CI).
 *
 * Fetches the real CIDB source — the machine-readable feed by default, or an
 * HTML listing when CIDB_SOURCE_URL points at one — runs it through the actual
 * connector pipeline and prints a summary. Use it to verify the source still
 * matches what the parser expects:
 *
 *   npm run test:cidb-live
 */
import { createConnector } from '../src/cidb/factory.js';
import { config } from '../src/config.js';

async function main(): Promise<void> {
  console.log(`Probing ${config.CIDB_SOURCE_URL} ...\n`);

  const connector = createConnector();
  const started = Date.now();
  const health = await connector.healthCheck();
  console.log(
    `Health: ${health.reachable ? 'reachable' : 'UNREACHABLE'} in ${Date.now() - started}ms — ${health.detail}`,
  );
  if (!health.reachable) {
    console.error('\nFAIL: source not usable — SOURCE_STRUCTURE_CHANGED or network problem');
    process.exit(1);
  }

  const records = await connector.discover();
  console.log(`Discovered records: ${records.length}`);
  if (records.length === 0) {
    console.error('\nFAIL: zero records discovered — SOURCE_STRUCTURE_CHANGED');
    process.exit(1);
  }

  const statuses = new Map<string, number>();
  for (const record of records.slice(0, 3)) {
    const parsed = await connector.parse(record);
    const normalized = await connector.normalize(parsed);
    console.log(`\n- ${normalized.externalId}`);
    console.log(`  bid:       ${normalized.bidNumber}`);
    console.log(`  title:     ${normalized.title.slice(0, 100)}`);
    console.log(`  published: ${normalized.publishedDate?.toISOString() ?? 'null'}  status: ${normalized.status}`);
    console.log(`  docs:      ${normalized.documents.length} (${normalized.documents.map((d) => d.documentType).join(', ')})`);
  }

  // Status spread across the whole source, so a mapping regression is visible.
  for (const record of records) {
    const normalized = await connector.normalize(await connector.parse(record));
    statuses.set(normalized.status, (statuses.get(normalized.status) ?? 0) + 1);
  }
  console.log(`\nStatus spread: ${[...statuses].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('\nOK: live source parse succeeded');
}

main().catch((error) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
