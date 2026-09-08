/**
 * CIDB ingestion worker entrypoint.
 *
 * Runs the scheduled synchronization loop (Render background worker).
 * Usage:
 *   npm run worker        # scheduled loop (+ immediate sync when SYNC_ON_START=true)
 *   npm run worker:once   # single sync, then exit (manual / cron-job style)
 */
import { syncEnvKeysToDatabase } from './auth/apiKey.js';
import { config } from './config.js';
import { checkDatabase, prisma } from './database/client.js';
import { checkRequiredTables } from './database/verify.js';
import { runScheduledSync, startScheduler, stopScheduler } from './jobs/syncJob.js';
import { logger } from './utils/logging.js';

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: 'WORKER_SHUTDOWN', signal }, 'Worker shutting down');
  stopScheduler();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');

  logger.info(
    { event: 'WORKER_START', source: config.CIDB_SOURCE_URL, cron: config.CIDB_SYNC_CRON, once },
    'CIDB worker starting',
  );

  const db = await checkDatabase();
  if (!db.connected) {
    logger.fatal({ event: 'DATABASE_ERROR' }, 'Cannot reach database; worker exiting');
    process.exit(1);
  }

  const tables = await checkRequiredTables(prisma).catch((error: unknown) => ({
    ok: false,
    missing: [`check failed: ${error instanceof Error ? error.message : String(error)}`],
  }));
  if (!tables.ok) {
    logger.fatal(
      { event: 'DATABASE_NOT_MIGRATED', missing: tables.missing },
      `Required tables are missing (${tables.missing.join(', ')}). The database was never migrated — ` +
        `ensure the start command runs 'npx prisma migrate deploy' before 'node dist/worker.js' ` +
        `(Render: service Settings → Docker Command). Worker exiting.`,
    );
    process.exit(1);
  }

  // Keys must exist for the API, but the worker also seeds them so a
  // worker-only deploy never leaves auth unconfigured.
  await syncEnvKeysToDatabase(prisma).catch((error) => {
    logger.error({ event: 'API_KEY_SEED_FAILED', error: (error as Error).message }, 'API key seeding failed');
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (once) {
    await runScheduledSync();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  }

  if (config.SYNC_ON_START) {
    void runScheduledSync();
  }
  startScheduler();

  // Keep the process alive; the scheduler + pending promises hold the loop.
  await new Promise(() => undefined);
}

main().catch((error) => {
  logger.fatal({ event: 'WORKER_FATAL', error: (error as Error).message }, 'Worker crashed');
  process.exit(1);
});
