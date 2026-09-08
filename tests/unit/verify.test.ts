import { describe, expect, it } from 'vitest';
import { REQUIRED_TABLES, checkRequiredTables } from '../../src/database/verify.js';
import { createMemoryDb } from '../../src/database/memory.js';
import { DbClient } from '../../src/database/types.js';

describe('checkRequiredTables', () => {
  it('passes when all tables exist (memory provider)', async () => {
    const { db } = createMemoryDb();
    await expect(checkRequiredTables(db)).resolves.toEqual({ ok: true, missing: [] });
  });

  it('reports missing tables when the database is unmigrated', async () => {
    const empty = { $queryRaw: async () => [] } as unknown as DbClient;
    await expect(checkRequiredTables(empty)).resolves.toEqual({ ok: false, missing: [...REQUIRED_TABLES] });
  });
});
