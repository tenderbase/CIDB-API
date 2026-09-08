import cron from 'node-cron';
import { createConnector } from '../cidb/factory.js';
import { config } from '../config.js';
import { prisma } from '../database/client.js';
import { executeSyncRun, startSyncRun, SyncAlreadyRunningError } from '../services/syncService.js';
import { childLogger, LOG_EVENTS } from '../utils/logging.js';

const log = childLogger({ job: 'cidb-sync' });

let running = false;
let task: cron.ScheduledTask | null = null;

/** Execute one sync unless another is already in flight (no overlapping runs). */
export async function runScheduledSync(): Promise<void> {
  if (running) {
    log.warn({ event: LOG_EVENTS.SYNC_SKIPPED_OVERLAP }, 'Skipping scheduled sync: previous run still in progress');
    return;
  }
  running = true;
  try {
    const connector = createConnector();
    const syncId = await startSyncRun(prisma, connector.source);
    await executeSyncRun(syncId, { db: prisma, connector });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      log.warn({ event: LOG_EVENTS.SYNC_SKIPPED_OVERLAP, syncId: error.syncId }, 'Skipping scheduled sync: already running');
    } else {
      log.error({ event: LOG_EVENTS.SYNC_FAILED, error: (error as Error).message }, 'Scheduled sync raised');
    }
  } finally {
    running = false;
  }
}

export function isSyncRunning(): boolean {
  return running;
}

export function startScheduler(): void {
  if (!cron.validate(config.CIDB_SYNC_CRON)) {
    throw new Error(`Invalid CIDB_SYNC_CRON expression: "${config.CIDB_SYNC_CRON}"`);
  }
  task = cron.schedule(config.CIDB_SYNC_CRON, () => {
    void runScheduledSync();
  });
  log.info({ event: 'SCHEDULER_STARTED', cron: config.CIDB_SYNC_CRON }, 'CIDB sync scheduler started');
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}
