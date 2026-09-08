import { createConnector } from '../cidb/factory.js';
import { ensureUniqueExternalIds } from '../cidb/normalizer.js';
import { TenderSourceConnector } from '../cidb/types.js';
import { config } from '../config.js';
import { DbClient, prisma } from '../database/client.js';
import { TenderCreateInput, TenderUpdateInput } from '../database/types.js';
import { NormalizedTender } from '../schemas/tender.js';
import { childLogger, LOG_EVENTS } from '../utils/logging.js';

/** A sync started longer ago than this with no completion is considered orphaned. */
const ORPHANED_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export class SyncAlreadyRunningError extends Error {
  readonly syncId: string;
  constructor(syncId: string) {
    super(`A synchronization is already running (syncId=${syncId})`);
    this.name = 'SyncAlreadyRunningError';
    this.syncId = syncId;
  }
}

export interface SyncSummary {
  syncId: string;
  status: string;
  recordsDiscovered: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsFailed: number;
  documentsFound: number;
  errorCount: number;
  durationMs: number;
}

export interface RunSyncOptions {
  connector?: TenderSourceConnector;
  db?: DbClient;
  /** Skip the suspicious-result guards (dangerous; used only by tests). */
  skipSuspiciousChecks?: boolean;
}

const log = childLogger({ service: 'sync' });

async function recordError(
  db: DbClient,
  syncRunId: string,
  error: { externalId?: string | null; url?: string | null; stage: string; errorType: string; message: string; stack?: string; retryCount?: number },
): Promise<void> {
  await db.syncError.create({
    data: {
      syncRunId,
      externalId: error.externalId ?? null,
      url: error.url ?? null,
      stage: error.stage,
      errorType: error.errorType,
      message: error.message.slice(0, 4000),
      stack: error.stack?.slice(0, 8000) ?? null,
      retryCount: error.retryCount ?? 0,
    },
  });
}

/**
 * Reserve a new SyncRun row. Throws SyncAlreadyRunningError when another
 * sync is active; orphans stale RUNNING rows left by crashed workers.
 */
export async function startSyncRun(db: DbClient = prisma, source = 'CIDB'): Promise<string> {
  const running = await db.syncRun.findMany({ where: { status: 'RUNNING' }, orderBy: { startedAt: 'asc' } });
  const now = Date.now();
  for (const run of running) {
    if (now - run.startedAt.getTime() > ORPHANED_RUN_TIMEOUT_MS) {
      await db.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          durationMs: now - run.startedAt.getTime(),
          errorMessage: 'Orphaned RUNNING sync reclaimed (worker likely crashed or was redeployed)',
        },
      });
      log.warn({ event: LOG_EVENTS.SYNC_FAILED, syncId: run.id }, 'Reclaimed orphaned sync run');
    } else {
      throw new SyncAlreadyRunningError(run.id);
    }
  }
  const run = await db.syncRun.create({ data: { source, status: 'RUNNING' } });
  return run.id;
}

/**
 * Guard against wiping good data with a bad scrape: fail the sync before
 * any writes when the discovered count collapses relative to history.
 */
export function evaluateSuspiciousResult(
  discovered: number,
  lastSuccessfulCount: number | null,
  options: { minExpectedRecords: number; maxDropRatio: number },
): string | null {
  if (lastSuccessfulCount === null || lastSuccessfulCount === 0) {
    // No baseline yet — only the absolute floor applies, and only when it
    // is configured above zero (fresh installs legitimately start at 0).
    if (options.minExpectedRecords > 0 && discovered < options.minExpectedRecords && discovered === 0) {
      return `SUSPICIOUS_ZERO_RESULTS: discovered 0 records (minimum expected: ${options.minExpectedRecords})`;
    }
    return null;
  }
  if (discovered === 0) {
    return `SUSPICIOUS_ZERO_RESULTS: discovered 0 records but previous successful sync found ${lastSuccessfulCount}`;
  }
  if (discovered < options.minExpectedRecords && lastSuccessfulCount >= options.minExpectedRecords) {
    return `SUSPICIOUS_LOW_COUNT: discovered ${discovered} records, below minimum expected ${options.minExpectedRecords} (previous: ${lastSuccessfulCount})`;
  }
  const dropRatio = (lastSuccessfulCount - discovered) / lastSuccessfulCount;
  if (dropRatio > options.maxDropRatio) {
    return (
      `SUSPICIOUS_DROP: discovered ${discovered} records, a ${Math.round(dropRatio * 100)}% drop ` +
      `from previous ${lastSuccessfulCount} (threshold: ${Math.round(options.maxDropRatio * 100)}%)`
    );
  }
  return null;
}

function toTenderCreate(tender: NormalizedTender): TenderCreateInput {
  return {
    source: tender.source,
    externalId: tender.externalId,
    bidNumber: tender.bidNumber,
    title: tender.title,
    description: tender.description,
    organisation: tender.organisation,
    province: tender.province,
    location: tender.location,
    municipality: tender.municipality,
    tenderType: tender.tenderType,
    status: tender.status,
    publishedDate: tender.publishedDate,
    closingDate: tender.closingDate,
    briefingDate: tender.briefingDate,
    briefingRequired: tender.briefingRequired,
    briefingLocation: tender.briefingLocation,
    cidbGrade: tender.cidbGrade,
    cidbGradeRaw: tender.cidbGradeRaw,
    cidbClass: tender.cidbClass,
    cidbClassRaw: tender.cidbClassRaw,
    estimatedValue: tender.estimatedValue,
    contactName: tender.contactName,
    contactEmail: tender.contactEmail,
    contactPhone: tender.contactPhone,
    sourceUrl: tender.sourceUrl,
    rawHash: tender.rawHash,
    rawData: tender.rawData,
    lastSeenAt: new Date(),
    documents: {
      create: tender.documents.map((d) => ({
        name: d.name,
        documentType: d.documentType,
        url: d.url,
        sourceUrl: d.sourceUrl,
        fileName: d.fileName,
        mimeType: d.mimeType,
      })),
    },
  };
}

function toTenderUpdate(tender: NormalizedTender): TenderUpdateInput {
  const { documents: _docs, ...rest } = toTenderCreate(tender);
  void _docs;
  const { source: _source, externalId: _externalId, ...updatable } = rest;
  void _source;
  void _externalId;
  return { ...updatable, lastSeenAt: new Date() };
}

/**
 * Execute the full pipeline for an already-reserved SyncRun row:
 * discover → fetch → parse → normalize → validate → upsert → finalize.
 */
export async function executeSyncRun(syncId: string, options: RunSyncOptions = {}): Promise<SyncSummary> {
  const db = options.db ?? prisma;
  const connector = options.connector ?? createConnector();
  const started = Date.now();
  const runLog = childLogger({ syncId, source: connector.source });

  let discovered = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let documentsFound = 0;
  let errorCount = 0;

  runLog.info({ event: LOG_EVENTS.SYNC_STARTED }, 'Synchronization started');
  await db.syncRun.update({ where: { id: syncId }, data: { status: 'RUNNING', startedAt: new Date(started) } });

  const failRun = async (message: string, error?: unknown): Promise<SyncSummary> => {
    const durationMs = Date.now() - started;
    runLog.error(
      { event: LOG_EVENTS.SYNC_FAILED, error: message },
      'Synchronization failed — existing data left untouched',
    );
    await db.syncRun.update({
      where: { id: syncId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        recordsDiscovered: discovered,
        recordsCreated: created,
        recordsUpdated: updated,
        recordsUnchanged: unchanged,
        recordsFailed: failed,
        documentsFound,
        errorCount,
        durationMs,
        errorMessage: message.slice(0, 4000),
      },
    });
    if (error) {
      errorCount += 1;
      await recordError(db, syncId, {
        stage: 'sync',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        message: message,
        stack: error instanceof Error ? error.stack : undefined,
        url: connector.sourceUrl,
      }).catch(() => undefined);
      await db.syncRun.update({ where: { id: syncId }, data: { errorCount } }).catch(() => undefined);
    }
    return {
      syncId,
      status: 'FAILED',
      recordsDiscovered: discovered,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsUnchanged: unchanged,
      recordsFailed: failed,
      documentsFound,
      errorCount,
      durationMs,
    };
  };

  // ── 1. Discover ──────────────────────────────────────────────────────────
  let records;
  try {
    records = await connector.discover();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failRun(`Discovery failed: ${message}`, error);
  }
  discovered = records.length;

  // ── 2. Suspicious-result guard (before any writes) ───────────────────────
  if (!options.skipSuspiciousChecks) {
    const lastGood = await db.syncRun.findFirst({
      where: { status: { in: ['COMPLETED', 'PARTIAL'] } },
      orderBy: { startedAt: 'desc' },
      select: { recordsDiscovered: true },
    });
    const suspicious = evaluateSuspiciousResult(discovered, lastGood?.recordsDiscovered ?? null, {
      minExpectedRecords: config.MIN_EXPECTED_RECORDS,
      maxDropRatio: config.MAX_DROP_RATIO,
    });
    if (suspicious) {
      runLog.error({ event: LOG_EVENTS.SUSPICIOUS_ZERO_RESULTS, discovered }, suspicious);
      return failRun(suspicious);
    }
  }

  // ── 3. Fetch + parse + normalize (per-record failures are isolated) ─────
  const normalized: NormalizedTender[] = [];
  for (const record of records) {
    try {
      const fetched = await connector.fetch(record);
      const parsed = await connector.parse(fetched);
      normalized.push(await connector.normalize(parsed));
    } catch (error) {
      failed += 1;
      errorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      await recordError(db, syncId, {
        externalId: record.sourceRecordId,
        url: record.sourceUrl,
        stage: 'normalize',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      runLog.warn({ event: 'RECORD_FAILED', error: message }, 'Record failed to normalize; continuing with next record');
    }
  }

  const unique = ensureUniqueExternalIds(normalized);

  // ── 4. Upsert with change detection ──────────────────────────────────────
  for (const tender of unique) {
    try {
      documentsFound += tender.documents.length;
      const existing = await db.tender.findUnique({
        where: { source_externalId: { source: tender.source, externalId: tender.externalId } },
        select: { id: true, rawHash: true },
      });
      if (!existing) {
        const createdRow = await db.tender.create({ data: toTenderCreate(tender), select: { id: true } });
        created += 1;
        runLog.info(
          { event: LOG_EVENTS.TENDER_CREATED, tenderId: createdRow.id, externalId: tender.externalId },
          'Tender created',
        );
      } else if (existing.rawHash === tender.rawHash) {
        await db.tender.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
        unchanged += 1;
      } else {
        await db.$transaction([
          db.tenderDocument.deleteMany({ where: { tenderId: existing.id } }),
          db.tender.update({
            where: { id: existing.id },
            data: {
              ...toTenderUpdate(tender),
              documents: {
                create: tender.documents.map((d) => ({
                  name: d.name,
                  documentType: d.documentType,
                  url: d.url,
                  sourceUrl: d.sourceUrl,
                  fileName: d.fileName,
                  mimeType: d.mimeType,
                })),
              },
            },
          }),
        ]);
        updated += 1;
        runLog.info(
          { event: LOG_EVENTS.TENDER_UPDATED, tenderId: existing.id, externalId: tender.externalId },
          'Tender updated (source changed)',
        );
      }
    } catch (error) {
      failed += 1;
      errorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      await recordError(db, syncId, {
        externalId: tender.externalId,
        url: tender.sourceUrl,
        stage: 'persist',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      runLog.error({ event: LOG_EVENTS.DATABASE_ERROR, externalId: tender.externalId, error: message }, 'Persist failed');
    }
  }

  // ── 5. Detect removed/closed tenders (grace period, never on failed syncs) ─
  let closedMissing = 0;
  if (config.MISSING_CLOSE_GRACE_DAYS > 0 && discovered > 0) {
    const cutoff = new Date(Date.now() - config.MISSING_CLOSE_GRACE_DAYS * 86_400_000);
    const result = await db.tender.updateMany({
      where: {
        source: connector.source,
        status: { in: ['OPEN', 'CLOSING_SOON', 'UNKNOWN'] },
        lastSeenAt: { lt: cutoff },
      },
      data: { status: 'CLOSED' },
    });
    closedMissing = result.count;
    if (closedMissing > 0) {
      runLog.info({ event: LOG_EVENTS.TENDER_CLOSED, count: closedMissing }, 'Stale tenders marked CLOSED');
    }
  }

  // ── 6. Finalize ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - started;
  const status = failed === 0 ? 'COMPLETED' : 'PARTIAL';
  await db.syncRun.update({
    where: { id: syncId },
    data: {
      status,
      completedAt: new Date(),
      recordsDiscovered: discovered,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsUnchanged: unchanged,
      recordsFailed: failed,
      documentsFound,
      errorCount,
      durationMs,
    },
  });
  runLog.info(
    {
      event: LOG_EVENTS.SYNC_COMPLETED,
      status,
      discovered,
      created,
      updated,
      unchanged,
      failed,
      documentsFound,
      closedMissing,
      durationMs,
    },
    'Synchronization completed',
  );

  return {
    syncId,
    status,
    recordsDiscovered: discovered,
    recordsCreated: created,
    recordsUpdated: updated,
    recordsUnchanged: unchanged,
    recordsFailed: failed,
    documentsFound,
    errorCount,
    durationMs,
  };
}

/** Reserve + execute a sync in one call (worker path). */
export async function runSync(options: RunSyncOptions = {}): Promise<SyncSummary> {
  const db = options.db ?? prisma;
  const connector = options.connector ?? createConnector();
  const syncId = await startSyncRun(db, connector.source);
  return executeSyncRun(syncId, { ...options, db, connector });
}
