/**
 * End-to-end sync pipeline tests: real parser + real normalizer + sync
 * orchestration against the in-memory DbClient.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeParsedTender } from '../../src/cidb/normalizer.js';
import { parseCurrentTendersHtml } from '../../src/cidb/parser.js';
import {
  ConnectorHealth,
  DiscoveredRecord,
  ParsedTender,
  TenderSourceConnector,
} from '../../src/cidb/types.js';
import { NormalizedTender } from '../../src/schemas/tender.js';
import {
  executeSyncRun,
  startSyncRun,
  SyncAlreadyRunningError,
} from '../../src/services/syncService.js';
import { DbClient } from '../../src/database/types.js';
import { createMemoryDb } from '../helpers/fakeDb.js';

const SOURCE_URL = 'https://stub.test/current-tenders';
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');

class StubConnector implements TenderSourceConnector {
  readonly source = 'CIDB';
  readonly sourceUrl = SOURCE_URL;
  failDiscover: Error | null = null;
  failNormalizeBids = new Set<string>();

  constructor(private records: ParsedTender[]) {}

  async discover(): Promise<DiscoveredRecord[]> {
    if (this.failDiscover) throw this.failDiscover;
    return this.records.map((record, index) => ({
      sourceRecordId: record.bidNumber,
      sourceUrl: this.sourceUrl,
      payload: { ...record, rowIndex: index },
    }));
  }

  async fetch(record: DiscoveredRecord): Promise<DiscoveredRecord> {
    return record;
  }

  async parse(record: DiscoveredRecord): Promise<ParsedTender> {
    const payload = record.payload as unknown as ParsedTender;
    return {
      bidNumber: payload.bidNumber,
      title: payload.title ?? null,
      description: payload.description,
      organisation: payload.organisation ?? null,
      publishedDate: payload.publishedDate,
      closingDate: payload.closingDate ?? null,
      locationText: payload.locationText ?? null,
      documents: payload.documents ?? [],
      sourceUrl: record.sourceUrl,
      extra: (payload.extra as Record<string, unknown>) ?? {},
    };
  }

  async normalize(parsed: ParsedTender): Promise<NormalizedTender> {
    if (parsed.bidNumber && this.failNormalizeBids.has(parsed.bidNumber)) {
      throw new Error(`boom on ${parsed.bidNumber}`);
    }
    return normalizeParsedTender(parsed);
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return { reachable: true, latencyMs: 1 };
  }
}

let db: DbClient;

beforeEach(() => {
  db = createMemoryDb().db;
});

async function runSync(connector: TenderSourceConnector, opts: { skipSuspiciousChecks?: boolean } = {}) {
  const syncId = await startSyncRun(db, 'CIDB');
  return executeSyncRun(syncId, { db, connector, skipSuspiciousChecks: opts.skipSuspiciousChecks });
}

function currentRecords(): ParsedTender[] {
  return parseCurrentTendersHtml(fixture('cidb-current.html'), SOURCE_URL);
}

describe('sync pipeline', () => {
  it('creates new tenders on first sync (COMPLETED)', async () => {
    const summary = await runSync(new StubConnector(currentRecords()));
    expect(summary.status).toBe('COMPLETED');
    expect(summary.recordsDiscovered).toBe(4);
    expect(summary.recordsCreated).toBe(4);
    expect(summary.recordsUnchanged).toBe(0);
    expect(summary.documentsFound).toBeGreaterThan(0);

    const count = await db.tender.count();
    expect(count).toBe(4);
    const kzn = await db.tender.findUnique({
      where: { source_externalId: { source: 'CIDB', externalId: 'CIDB-CIDB-002-2526' } },
    });
    expect(kzn).toMatchObject({ province: 'KwaZulu-Natal', bidNumber: 'CIDB 002 2526' });
  });

  it('is idempotent: second sync leaves everything unchanged', async () => {
    await runSync(new StubConnector(currentRecords()));
    const second = await runSync(new StubConnector(currentRecords()));
    expect(second.status).toBe('COMPLETED');
    expect(second.recordsCreated).toBe(0);
    expect(second.recordsUpdated).toBe(0);
    expect(second.recordsUnchanged).toBe(4);
    expect(await db.tender.count()).toBe(4);
  });

  it('updates only the changed record', async () => {
    await runSync(new StubConnector(currentRecords()));
    const changed = currentRecords();
    changed[1] = { ...changed[1], description: `${changed[1].description} Additional closing note.` };
    const summary = await runSync(new StubConnector(changed));
    expect(summary.recordsUpdated).toBe(1);
    expect(summary.recordsUnchanged).toBe(3);
    expect(await db.tender.count()).toBe(4);
  });

  it('disambiguates duplicate bid numbers without unique violations', async () => {
    const dupes = parseCurrentTendersHtml(fixture('cidb-duplicate.html'), SOURCE_URL);
    expect(dupes).toHaveLength(2);
    const summary = await runSync(new StubConnector(dupes));
    expect(summary.status).toBe('COMPLETED');
    expect(summary.recordsCreated).toBe(2);
    const ids = (await db.tender.findMany({})).map((t) => t.externalId).sort();
    expect(ids).toEqual(['CIDB-CIDB-010-2526', 'CIDB-CIDB-010-2526-2']);
    // And re-syncing stays idempotent.
    const second = await runSync(new StubConnector(dupes));
    expect(second.recordsUnchanged).toBe(2);
    expect(second.recordsCreated).toBe(0);
  });

  it('isolates per-record failures and reports PARTIAL', async () => {
    const connector = new StubConnector(currentRecords());
    connector.failNormalizeBids.add('cidb 005 2627');
    const summary = await runSync(connector);
    expect(summary.status).toBe('PARTIAL');
    expect(summary.recordsCreated).toBe(3);
    expect(summary.recordsFailed).toBe(1);
    expect(summary.errorCount).toBe(1);
    const errors = await db.syncError.findMany({ where: { syncRunId: summary.syncId } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ stage: 'normalize', externalId: 'cidb 005 2627' });
  });

  it('fails the run without writes when discovery fails', async () => {
    const connector = new StubConnector([]);
    connector.failDiscover = new Error('connection reset');
    const summary = await runSync(connector);
    expect(summary.status).toBe('FAILED');
    expect(summary.errorCount).toBe(1);
    expect(await db.tender.count()).toBe(0);
    const run = await db.syncRun.findUnique({ where: { id: summary.syncId } });
    expect(run?.errorMessage).toContain('Discovery failed');
  });

  it('fails suspicious zero-result syncs and preserves existing data', async () => {
    await runSync(new StubConnector(currentRecords()));
    expect(await db.tender.count()).toBe(4);
    const summary = await runSync(new StubConnector([]));
    expect(summary.status).toBe('FAILED');
    expect(summary.recordsDiscovered).toBe(0);
    expect(await db.tender.count()).toBe(4);
    const run = await db.syncRun.findUnique({ where: { id: summary.syncId } });
    expect(run?.errorMessage).toMatch(/SUSPICIOUS_ZERO_RESULTS/);
  });

  it('marks long-missing tenders CLOSED after the grace period', async () => {
    await runSync(new StubConnector(currentRecords()));
    // Simulate a tender that vanished from the source 10 days ago.
    const victim = await db.tender.findFirst({ where: { externalId: 'CIDB-CIDB-011-2526' } });
    expect(victim).not.toBeNull();
    const stale = new Date(Date.now() - 10 * 86_400_000);
    // Backdate directly in the fake store via update.
    await db.tender.update({ where: { id: victim!.id }, data: { lastSeenAt: stale } });

    const remaining = currentRecords().filter((r) => r.bidNumber !== 'cidb 011 2526');
    const summary = await runSync(new StubConnector(remaining), { skipSuspiciousChecks: true });
    expect(summary.status).toBe('COMPLETED');
    const after = await db.tender.findFirst({ where: { externalId: 'CIDB-CIDB-011-2526' } });
    expect(after?.status).toBe('CLOSED');
    // Still-present tenders stay open.
    const present = await db.tender.findFirst({ where: { externalId: 'CIDB-CIDB-004-2627' } });
    expect(present?.status).not.toBe('CLOSED');
  });

  it('ingests the full 19-row live capture including the genuine duplicate', async () => {
    const full = parseCurrentTendersHtml(fixture('cidb-full.html'), SOURCE_URL);
    expect(full).toHaveLength(19);
    const summary = await runSync(new StubConnector(full));
    expect(summary.status).toBe('COMPLETED');
    expect(summary.recordsDiscovered).toBe(19);
    expect(summary.recordsCreated).toBe(19);
    expect(summary.documentsFound).toBeGreaterThan(19);
    // The live page genuinely repeats cidb 010 2526 → deterministic -2 suffix.
    const dupes = (await db.tender.findMany({})).map((t) => t.externalId).filter((id) => id.includes('010-2526')).sort();
    expect(dupes).toEqual(['CIDB-CIDB-010-2526', 'CIDB-CIDB-010-2526-2']);
    // Re-sync is fully idempotent.
    const second = await runSync(new StubConnector(full));
    expect(second).toMatchObject({ recordsCreated: 0, recordsUpdated: 0, recordsUnchanged: 19 });
  });

  it('rejects overlapping syncs and reclaims orphaned runs', async () => {
    const first = await startSyncRun(db, 'CIDB');
    await expect(startSyncRun(db, 'CIDB')).rejects.toThrowError(SyncAlreadyRunningError);

    // Age the running sync past the orphan timeout, then start again.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await db.syncRun.update({ where: { id: first }, data: { startedAt: stale } });
    const second = await startSyncRun(db, 'CIDB');
    expect(second).not.toBe(first);
    const orphan = await db.syncRun.findUnique({ where: { id: first } });
    expect(orphan?.status).toBe('FAILED');
    expect(orphan?.errorMessage).toMatch(/Orphaned/);
  });
});
