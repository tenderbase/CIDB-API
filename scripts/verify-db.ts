/**
 * Database smoke test against a REAL PostgreSQL (Neon).
 *
 *   DATABASE_URL="postgresql://..." npm run verify:db [-- --write]
 *
 * Read-only by default: exercises connectivity plus every query path the API
 * and worker use (list/search/filters/stats raw SQL). With `--write` it also
 * performs a labeled canary SyncRun write (safe to delete afterwards).
 *
 * Requires `npx prisma generate` + migrated database. This is the script to
 * run once after pointing the service at Neon for the first time.
 */
import { listTenders } from '../src/services/tenderService.js';
import { getStats } from '../src/services/statsService.js';
import { checkDatabase, prisma } from '../src/database/client.js';
import { tenderListQuerySchema } from '../src/schemas/query.js';

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    console.log(`  ok   ${name}${typeof result === 'string' ? ` (${result})` : ''}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const doWrite = process.argv.includes('--write');
  console.log('CIDB Tender API — database verification');
  console.log(`Target: ${(process.env.DATABASE_URL ?? '').replace(/:[^:@/]+@/, ':****@')}\n`);

  await check('connectivity (SELECT 1)', async () => {
    const db = await checkDatabase();
    if (!db.connected) throw new Error('database unreachable');
    return `${db.latencyMs}ms`;
  });
  if (process.exitCode) return;

  await check('tables present', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('Tender','TenderDocument','SyncRun','SyncError','ApiKey')`;
    if (tables.length !== 5) throw new Error(`expected 5 tables, found ${tables.length} (run migrations?)`);
    return tables.map((t) => t.tablename).join(',');
  });

  await check('tender list + pagination', async () => {
    const page = await listTenders(tenderListQuerySchema.parse({ limit: 5 }));
    return `total=${page.pagination.total}`;
  });

  await check('search + filters + sorting', async () => {
    await listTenders(tenderListQuerySchema.parse({ search: 'construction', status: 'OPEN', sort: 'closingDate', order: 'asc' }));
    await listTenders(tenderListQuerySchema.parse({ province: 'Gauteng', cidbGrade: '6', cidbClass: 'CE' }));
    return 'filters ok';
  });

  await check('stats incl. raw class-breakdown SQL', async () => {
    const stats = await getStats();
    return `tenders=${stats.totalTenders} open=${stats.openTenders}`;
  });

  await check('sync history + error queries', async () => {
    await prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 5 });
    await prisma.syncError.count();
    return 'ok';
  });

  await check('api key lookup', async () => {
    await prisma.apiKey.findUnique({ where: { name: 'env-default' } });
    return 'ok';
  });

  await check('transaction support', async () => {
    await prisma.$transaction([prisma.tender.count(), prisma.syncRun.count()]);
    return 'ok';
  });

  if (doWrite) {
    await check('canary SyncRun write', async () => {
      const run = await prisma.syncRun.create({ data: { source: 'VERIFY-SMOKE', status: 'RUNNING' } });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', completedAt: new Date(), errorMessage: 'Smoke test row — safe to delete' },
      });
      return `id=${run.id}`;
    });
  } else {
    console.log('  skip canary write (pass --write to enable)');
  }

  await prisma.$disconnect().catch(() => undefined);
  console.log(process.exitCode ? '\nVerification FAILED' : '\nVerification PASSED');
}

main().catch((error) => {
  console.error(`\nFATAL: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Hint: this script needs a generated Prisma client (`npx prisma generate`) and a migrated database.');
  process.exit(1);
});
