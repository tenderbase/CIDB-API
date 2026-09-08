/**
 * CIDB Tender API entrypoint (Render web service).
 */
import { syncEnvKeysToDatabase } from '../auth/apiKey.js';
import { config } from '../config.js';
import { checkDatabase, prisma } from '../database/client.js';
import { checkRequiredTables } from '../database/verify.js';
import { logger } from '../utils/logging.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const db = await checkDatabase();
  if (!db.connected) {
    logger.fatal({ event: 'DATABASE_ERROR' }, 'Cannot reach database; API exiting');
    process.exit(1);
  }
  logger.info({ event: 'DATABASE_CONNECTED', latencyMs: db.latencyMs }, 'Database connected');

  const tables = await checkRequiredTables(prisma).catch((error: unknown) => ({
    ok: false,
    missing: [`check failed: ${error instanceof Error ? error.message : String(error)}`],
  }));
  if (!tables.ok) {
    logger.fatal(
      { event: 'DATABASE_NOT_MIGRATED', missing: tables.missing },
      `Required tables are missing (${tables.missing.join(', ')}). The database was never migrated — ` +
        `ensure the start command runs 'npx prisma migrate deploy' before 'node dist/api/server.js' ` +
        `(Render: service Settings → Docker Command). API exiting.`,
    );
    process.exit(1);
  }

  await syncEnvKeysToDatabase(prisma).catch((error) => {
    logger.error({ event: 'API_KEY_SEED_FAILED', error: (error as Error).message }, 'API key seeding failed');
  });

  if (config.API_SYNC_ON_START) {
    // Dev convenience (typically paired with DB_MODE=memory + file: source):
    // ingest once before accepting traffic so the API is testable immediately.
    const { runSync } = await import('../services/syncService.js');
    try {
      const summary = await runSync();
      logger.info(
        { event: 'API_BOOT_SYNC', ...summary },
        `Boot sync finished: ${summary.status} (${summary.recordsCreated} created, ${summary.recordsUnchanged} unchanged)`,
      );
    } catch (error) {
      logger.error(
        { event: 'API_BOOT_SYNC_FAILED', error: (error as Error).message },
        'Boot sync failed; API will still serve stored data',
      );
    }
  }

  const app = await buildApp();

  const shutdown = async (signal: string) => {
    logger.info({ event: 'API_SHUTDOWN', signal }, 'API shutting down');
    try {
      await app.close();
    } catch {
      // ignore
    }
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Render injects PORT; bind 0.0.0.0 so the platform can reach us.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ event: 'API_LISTENING', port: config.PORT }, `CIDB Tender API listening on port ${config.PORT}`);
}

main().catch((error) => {
  logger.fatal({ event: 'API_FATAL', error: (error as Error).message }, 'API crashed on startup');
  process.exit(1);
});
