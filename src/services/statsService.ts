import { config } from '../config.js';
import { DbClient, prisma } from '../database/client.js';

export interface StatsResponse {
  totalTenders: number;
  openTenders: number;
  closingSoon: number;
  closedTenders: number;
  lastSync: string | null;
  lastSuccessfulSync: string | null;
  recordsAddedLastSync: number;
  recordsUpdatedLastSync: number;
  byProvince: Array<{ province: string; count: number }>;
  byGrade: Array<{ grade: string; count: number }>;
  byClass: Array<{ class: string; count: number }>;
}

export async function getStats(db: DbClient = prisma): Promise<StatsResponse> {
  const now = new Date();
  const closingCutoff = new Date(now.getTime() + config.CLOSING_SOON_DAYS * 86_400_000);

  const [
    totalTenders,
    openTenders,
    closingSoon,
    closedTenders,
    lastSync,
    lastSuccessfulSync,
    byProvinceRaw,
    byGradeRaw,
    classRows,
  ] = await Promise.all([
    db.tender.count(),
    db.tender.count({ where: { status: { in: ['OPEN', 'CLOSING_SOON'] } } }),
    db.tender.count({
      where: {
        status: { in: ['OPEN', 'CLOSING_SOON', 'UNKNOWN'] },
        closingDate: { gte: now, lte: closingCutoff },
      },
    }),
    db.tender.count({ where: { status: 'CLOSED' } }),
    db.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    db.syncRun.findFirst({ where: { status: { in: ['COMPLETED', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' } }),
    db.tender.groupBy({ by: ['province'], _count: { province: true }, where: { province: { not: null } } }),
    db.tender.groupBy({ by: ['cidbGrade'], _count: { cidbGrade: true }, where: { cidbGrade: { not: null } } }),
    // Postgres array column: aggregate class codes in SQL via raw query.
    db.$queryRaw<Array<{ class: string; count: bigint }>>`
      SELECT unnest("cidbClass") AS class, COUNT(*)::bigint AS count
      FROM "Tender" WHERE cardinality("cidbClass") > 0 GROUP BY 1 ORDER BY 2 DESC`,
  ]);

  return {
    totalTenders,
    openTenders,
    closingSoon,
    closedTenders,
    lastSync: lastSync?.startedAt.toISOString() ?? null,
    lastSuccessfulSync: lastSuccessfulSync?.startedAt.toISOString() ?? null,
    recordsAddedLastSync: lastSuccessfulSync?.recordsCreated ?? 0,
    recordsUpdatedLastSync: lastSuccessfulSync?.recordsUpdated ?? 0,
    byProvince: byProvinceRaw
      .filter((r) => r.province)
      .map((r) => ({ province: r.province as string, count: r._count.province }))
      .sort((a, b) => b.count - a.count),
    byGrade: byGradeRaw
      .filter((r) => r.cidbGrade)
      .map((r) => ({ grade: r.cidbGrade as string, count: r._count.cidbGrade }))
      .sort((a, b) => a.grade.localeCompare(b.grade)),
    byClass: classRows.map((r) => ({ class: r.class, count: Number(r.count) })),
  };
}
