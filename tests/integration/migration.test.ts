/**
 * Executes prisma/migrations/0001_init/migration.sql against real PostgreSQL
 * (PGlite, in-process) and verifies schema semantics: defaults, unique
 * constraints, foreign-key cascades, array handling and the stats query.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '0001_init', 'migration.sql'),
  'utf8',
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(MIGRATION_SQL);
});

afterAll(async () => {
  await pg.close();
});

describe('initial migration', () => {
  it('creates all tables, enums and indexes', async () => {
    const tables = await pg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.tablename).sort()).toEqual(
      ['ApiKey', 'SyncError', 'SyncRun', 'Tender', 'TenderDocument'].sort(),
    );
    const enums = await pg.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname IN ('TenderStatus','SyncStatus','ApiKeyRole','DownloadStatus')`,
    );
    expect(enums.rows).toHaveLength(4);
    const indexes = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Tender'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain('Tender_source_externalId_key');
    expect(names).toContain('Tender_status_idx');
    expect(names).toContain('Tender_province_idx');
    expect(names).toContain('Tender_closingDate_idx');
  });

  it('applies column defaults', async () => {
    await pg.query(
      `INSERT INTO "Tender" ("id","externalId","title","sourceUrl","rawHash","rawData") VALUES ('t1','CIDB-X','T','https://x.test','h','{}')`,
    );
    const row = await pg.query<{
      source: string;
      status: string;
      cidbClass: string[];
      briefingRequired: boolean;
    }>(`SELECT source, status, "cidbClass", "briefingRequired" FROM "Tender" WHERE id = 't1'`);
    expect(row.rows[0]).toMatchObject({
      source: 'CIDB',
      status: 'UNKNOWN',
      cidbClass: [],
      briefingRequired: false,
    });
  });

  it('enforces the (source, externalId) deduplication constraint', async () => {
    await pg.query(
      `INSERT INTO "Tender" ("id","externalId","title","sourceUrl","rawHash","rawData") VALUES ('t2','CIDB-DUP','T','https://x.test','h','{}')`,
    );
    await expect(
      pg.query(
        `INSERT INTO "Tender" ("id","externalId","title","sourceUrl","rawHash","rawData") VALUES ('t3','CIDB-DUP','T','https://x.test','h','{}')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('cascades document deletes and enforces per-tender document uniqueness', async () => {
    await pg.query(
      `INSERT INTO "TenderDocument" ("id","tenderId","name","url","sourceUrl") VALUES ('d1','t1','Doc','https://x.test/d.pdf','https://x.test')`,
    );
    await expect(
      pg.query(
        `INSERT INTO "TenderDocument" ("id","tenderId","name","url","sourceUrl") VALUES ('d2','t1','Doc again','https://x.test/d.pdf','https://x.test')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
    await pg.query(`DELETE FROM "Tender" WHERE id = 't1'`);
    const remaining = await pg.query(`SELECT id FROM "TenderDocument" WHERE id = 'd1'`);
    expect(remaining.rows).toHaveLength(0);
  });

  it('supports the class-breakdown stats query', async () => {
    await pg.query(`UPDATE "Tender" SET "cidbClass" = ARRAY['CE','GB'] WHERE id = 't2'`);
    const stats = await pg.query<{ class: string; count: number | string | bigint }>(
      `SELECT unnest("cidbClass") AS class, COUNT(*)::bigint AS count FROM "Tender" WHERE cardinality("cidbClass") > 0 GROUP BY 1 ORDER BY 2 DESC`,
    );
    // Drivers disagree on int8 mapping (number vs string vs bigint); the
    // service normalizes with Number(), so assert on the normalized value.
    const normalized = stats.rows.map((r) => ({ class: r.class, count: Number(r.count) }));
    expect(normalized).toContainEqual({ class: 'CE', count: 1 });
    expect(normalized).toContainEqual({ class: 'GB', count: 1 });
  });

  it('stores API keys with unique name and hash', async () => {
    await pg.query(`INSERT INTO "ApiKey" ("id","name","keyHash","role") VALUES ('k1','env-default','abc','ADMIN')`);
    await expect(
      pg.query(`INSERT INTO "ApiKey" ("id","name","keyHash") VALUES ('k2','env-default','def')`),
    ).rejects.toThrow(/duplicate key|unique/i);
    const row = await pg.query<{ active: boolean }>(`SELECT active FROM "ApiKey" WHERE id = 'k1'`);
    expect(row.rows[0].active).toBe(true);
  });

  it('records sync runs and linked errors', async () => {
    await pg.query(`INSERT INTO "SyncRun" ("id") VALUES ('s1')`);
    await pg.query(
      `INSERT INTO "SyncError" ("id","syncRunId","stage","errorType","message") VALUES ('e1','s1','parse','TestError','boom')`,
    );
    const row = await pg.query<{ status: string; recordsDiscovered: number }>(
      `SELECT status, "recordsDiscovered" FROM "SyncRun" WHERE id = 's1'`,
    );
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', recordsDiscovered: 0 });
  });
});
