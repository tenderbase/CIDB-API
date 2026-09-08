import { DbClient, prisma } from './client.js';

export const REQUIRED_TABLES = ['Tender', 'TenderDocument', 'SyncRun', 'SyncError', 'ApiKey'] as const;

/**
 * Verify the database has been migrated. Returns the list of missing tables
 * (empty when everything is in place). A missing table means
 * `prisma migrate deploy` never ran against this database — the single most
 * common production boot failure, so callers fail fast with guidance.
 */
export async function checkRequiredTables(
  db: DbClient = prisma,
): Promise<{ ok: boolean; missing: string[] }> {
  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const present = new Set(rows.map((r) => r.tablename));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  return { ok: missing.length === 0, missing: [...missing] };
}
