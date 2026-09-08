/**
 * In-memory DbClient implementation.
 *
 * Activation: `DB_MODE=memory`. Intended for LOCAL TESTING AND DEVELOPMENT
 * ONLY — data lives in the process heap and vanishes on restart. Production
 * always uses Prisma + PostgreSQL (`DB_MODE=postgres`, the default).
 *
 * Mirrors the Prisma query semantics this project relies on (AND/OR,
 * contains/equals with mode, in, has, date ranges, not-null, ordering with
 * PostgreSQL null placement, skip/take, nested document create). It is NOT
 * a general Prisma emulator — raw SQL and DDL are validated separately
 * against real PostgreSQL (PGlite) in tests/integration/migration.test.ts.
 */
import { hashApiKey } from '../utils/hashing.js';
import {
  ApiKeyRow,
  DateFilter,
  DbClient,
  StringFilter,
  SyncErrorRow,
  SyncRunRow,
  TenderCreateInput,
  TenderDocumentRow,
  TenderOrderByInput,
  TenderRow,
  TenderWhereInput,
  TenderWithDocuments,
} from './types.js';

export interface FakeStore {
  tenders: TenderRow[];
  documents: TenderDocumentRow[];
  syncRuns: SyncRunRow[];
  syncErrors: SyncErrorRow[];
  apiKeys: ApiKeyRow[];
}

let idCounter = 0;
export function fakeId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Date.now().toString(36)}`;
}

// ─── Matching ─────────────────────────────────────────────────────────────

function fold(value: string, mode?: string): string {
  return mode === 'insensitive' ? value.toLowerCase() : value;
}

function matchStringField(value: string | null, filter: string | StringFilter | null | undefined): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === null;
  if (typeof filter === 'string') return value === filter;
  if (filter.equals !== undefined) {
    if (value === null) return false;
    return fold(value, filter.mode) === fold(filter.equals, filter.mode);
  }
  if (filter.contains !== undefined) {
    if (value === null) return false;
    return fold(value, filter.mode).includes(fold(filter.contains, filter.mode));
  }
  if (filter.in !== undefined) return value !== null && filter.in.includes(value);
  if (filter.not !== undefined) {
    if (filter.not === null) return value !== null;
    return value !== filter.not;
  }
  return true;
}

function matchDateField(value: Date | null, filter: DateFilter | undefined): boolean {
  if (!filter) return true;
  if (value === null) return false;
  const t = value.getTime();
  if (filter.gte && t < filter.gte.getTime()) return false;
  if (filter.lte && t > filter.lte.getTime()) return false;
  if (filter.gt && t <= filter.gt.getTime()) return false;
  if (filter.lt && t >= filter.lt.getTime()) return false;
  return true;
}

export function matchTender(row: TenderRow, where: TenderWhereInput | undefined): boolean {
  if (!where) return true;
  if (where.AND && !where.AND.every((w) => matchTender(row, w))) return false;
  if (where.OR && !where.OR.some((w) => matchTender(row, w))) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.source !== undefined && row.source !== where.source) return false;
  if (where.externalId !== undefined && row.externalId !== where.externalId) return false;
  if (!matchStringField(row.bidNumber, where.bidNumber)) return false;
  if (!matchStringField(row.title, where.title)) return false;
  if (!matchStringField(row.description, where.description)) return false;
  if (!matchStringField(row.organisation, where.organisation)) return false;
  if (!matchStringField(row.province, where.province)) return false;
  if (!matchStringField(row.location, where.location)) return false;
  if (!matchStringField(row.municipality, where.municipality)) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'string') {
      if (row.status !== where.status) return false;
    } else if (!where.status.in.includes(row.status)) return false;
  }
  if (where.cidbGrade !== undefined) {
    const g = where.cidbGrade;
    if (typeof g === 'string' || g === null) {
      if (row.cidbGrade !== g) return false;
    } else if (!matchStringField(row.cidbGrade, g)) return false;
  }
  if (where.cidbClass !== undefined && !row.cidbClass.includes(where.cidbClass.has)) return false;
  if (!matchDateField(row.publishedDate, where.publishedDate)) return false;
  if (!matchDateField(row.closingDate, where.closingDate)) return false;
  if (!matchDateField(row.lastSeenAt, where.lastSeenAt)) return false;
  return true;
}

type OrderValue = string | number | Date | null | undefined;

function compareValues(a: OrderValue, b: OrderValue, dir: 'asc' | 'desc'): number {
  // PostgreSQL default null placement: NULLS LAST on ASC, NULLS FIRST on DESC.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : dir === 'asc' ? 1 : -1;
  if (b === null || b === undefined) return dir === 'asc' ? -1 : 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return dir === 'asc' ? -1 : 1;
  if (av > bv) return dir === 'asc' ? 1 : -1;
  return 0;
}

function sortTenders(rows: TenderRow[], orderBy: TenderOrderByInput | undefined): TenderRow[] {
  if (!orderBy) return rows;
  const entries = Object.entries(orderBy) as Array<[keyof TenderRow, 'asc' | 'desc']>;
  if (entries.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const [field, dir] of entries) {
      const cmp = compareValues(a[field] as OrderValue, b[field] as OrderValue, dir);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function withDocuments(store: FakeStore, row: TenderRow): TenderWithDocuments {
  return { ...row, documents: store.documents.filter((d) => d.tenderId === row.id) };
}

// ─── Factory ──────────────────────────────────────────────────────────────

export function createMemoryDb(): { db: DbClient; store: FakeStore } {
  const store: FakeStore = { tenders: [], documents: [], syncRuns: [], syncErrors: [], apiKeys: [] };
  const now = () => new Date();

  const db: DbClient = {
    tender: {
      async count(args) {
        return store.tenders.filter((t) => matchTender(t, args?.where)).length;
      },
      async findMany(args) {
        const rows = sortTenders(
          store.tenders.filter((t) => matchTender(t, args.where)),
          args.orderBy,
        );
        const sliced = rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
        return sliced.map((t) => withDocuments(store, t));
      },
      async findFirst(args) {
        const rows = sortTenders(
          store.tenders.filter((t) => matchTender(t, args.where)),
          args.orderBy,
        );
        const first = rows[0] ?? null;
        if (!first) return null;
        return withDocuments(store, first);
      },
      async findUnique(args) {
        const w = args.where as { id?: string; source_externalId?: { source: string; externalId: string } };
        const row = w.id
          ? store.tenders.find((t) => t.id === w.id)
          : store.tenders.find((t) => t.source === w.source_externalId?.source && t.externalId === w.source_externalId?.externalId);
        return row ? withDocuments(store, row) : null;
      },
      async create(args) {
        const data = args.data;
        const timestamp = now();
        const row: TenderRow = {
          id: fakeId('tender'),
          source: data.source,
          externalId: data.externalId,
          bidNumber: data.bidNumber ?? null,
          title: data.title,
          description: data.description ?? null,
          organisation: data.organisation ?? null,
          province: data.province ?? null,
          location: data.location ?? null,
          municipality: data.municipality ?? null,
          tenderType: data.tenderType ?? null,
          status: data.status,
          publishedDate: data.publishedDate ?? null,
          closingDate: data.closingDate ?? null,
          briefingDate: data.briefingDate ?? null,
          briefingRequired: data.briefingRequired ?? false,
          briefingLocation: data.briefingLocation ?? null,
          cidbGrade: data.cidbGrade ?? null,
          cidbGradeRaw: data.cidbGradeRaw ?? null,
          cidbClass: data.cidbClass ?? [],
          cidbClassRaw: data.cidbClassRaw ?? null,
          estimatedValue: (data.estimatedValue ?? null) as TenderRow['estimatedValue'],
          contactName: data.contactName ?? null,
          contactEmail: data.contactEmail ?? null,
          contactPhone: data.contactPhone ?? null,
          sourceUrl: data.sourceUrl,
          rawHash: data.rawHash,
          rawData: data.rawData,
          firstSeenAt: timestamp,
          lastSeenAt: data.lastSeenAt ?? timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        for (const doc of data.documents?.create ?? []) {
          store.documents.push({
            id: fakeId('doc'),
            tenderId: row.id,
            name: doc.name,
            documentType: doc.documentType,
            url: doc.url,
            sourceUrl: doc.sourceUrl,
            fileName: doc.fileName ?? null,
            mimeType: doc.mimeType ?? null,
            fileSize: null,
            contentHash: null,
            downloadStatus: 'NOT_DOWNLOADED',
            downloadedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
        store.tenders.push(row);
        return row;
      },
      async update(args) {
        const row = store.tenders.find((t) => t.id === args.where.id);
        if (!row) throw new Error(`Tender not found: ${args.where.id}`);
        const { documents, ...rest } = args.data;
        Object.assign(row, rest, { updatedAt: now() });
        if (documents?.create) {
          const timestamp = now();
          for (const doc of documents.create) {
            store.documents.push({
              id: fakeId('doc'),
              tenderId: row.id,
              name: doc.name,
              documentType: doc.documentType,
              url: doc.url,
              sourceUrl: doc.sourceUrl,
              fileName: doc.fileName ?? null,
              mimeType: doc.mimeType ?? null,
              fileSize: null,
              contentHash: null,
              downloadStatus: 'NOT_DOWNLOADED',
              downloadedAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
        }
        return row;
      },
      async updateMany(args) {
        let count = 0;
        for (const row of store.tenders) {
          if (matchTender(row, args.where)) {
            Object.assign(row, args.data, { updatedAt: now() });
            count += 1;
          }
        }
        return { count };
      },
      async groupBy(args) {
        const field = args.by[0];
        const groups = new Map<string, number>();
        for (const row of store.tenders) {
          if (!matchTender(row, args.where)) continue;
          const value = (row as unknown as Record<string, unknown>)[field];
          if (typeof value !== 'string') continue;
          groups.set(value, (groups.get(value) ?? 0) + 1);
        }
        return [...groups.entries()].map(([value, count]) => ({
          [field]: value,
          _count: { [field]: count },
        }));
      },
    },

    tenderDocument: {
      async count(args) {
        if (!args?.where?.tenderId) return store.documents.length;
        return store.documents.filter((d) => d.tenderId === args.where?.tenderId).length;
      },
      async findMany(args) {
        let rows = store.documents;
        if (args.where?.tenderId) rows = rows.filter((d) => d.tenderId === args.where?.tenderId);
        if (args.orderBy) {
          rows = [...rows].sort((a, b) => {
            for (const clause of args.orderBy ?? []) {
              for (const [field, dir] of Object.entries(clause) as Array<[keyof TenderDocumentRow, 'asc' | 'desc']>) {
                const cmp = compareValues(a[field] as OrderValue, b[field] as OrderValue, dir);
                if (cmp !== 0) return cmp;
              }
            }
            return 0;
          });
        }
        return rows;
      },
      async deleteMany(args) {
        const before = store.documents.length;
        store.documents = store.documents.filter((d) => d.tenderId !== args.where.tenderId);
        return { count: before - store.documents.length };
      },
    },

    syncRun: {
      async create(args) {
        const timestamp = now();
        const row: SyncRunRow = {
          id: fakeId('sync'),
          source: args.data.source,
          status: args.data.status ?? 'RUNNING',
          startedAt: args.data.startedAt ?? timestamp,
          completedAt: args.data.completedAt ?? null,
          recordsDiscovered: args.data.recordsDiscovered ?? 0,
          recordsCreated: args.data.recordsCreated ?? 0,
          recordsUpdated: args.data.recordsUpdated ?? 0,
          recordsUnchanged: args.data.recordsUnchanged ?? 0,
          recordsFailed: args.data.recordsFailed ?? 0,
          documentsFound: args.data.documentsFound ?? 0,
          errorCount: args.data.errorCount ?? 0,
          durationMs: args.data.durationMs ?? null,
          errorMessage: args.data.errorMessage ?? null,
          createdAt: timestamp,
        };
        store.syncRuns.push(row);
        return row;
      },
      async update(args) {
        const row = store.syncRuns.find((r) => r.id === args.where.id);
        if (!row) throw new Error(`SyncRun not found: ${args.where.id}`);
        Object.assign(row, args.data);
        return row;
      },
      async findFirst(args) {
        let rows = [...store.syncRuns];
        if (args?.where?.status !== undefined) {
          const s = args.where.status;
          rows = rows.filter((r) => (typeof s === 'string' ? r.status === s : s.in.includes(r.status)));
        }
        rows.sort((a, b) =>
          args?.orderBy?.startedAt === 'asc'
            ? a.startedAt.getTime() - b.startedAt.getTime()
            : b.startedAt.getTime() - a.startedAt.getTime(),
        );
        return rows[0] ?? null;
      },
      async findMany(args) {
        let rows = [...store.syncRuns];
        if (args?.where?.status !== undefined) {
          const s = args.where.status;
          rows = rows.filter((r) => (typeof s === 'string' ? r.status === s : s.in.includes(r.status)));
        }
        rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        const sliced = rows.slice(args?.skip ?? 0, args?.take === undefined ? undefined : (args.skip ?? 0) + args.take);
        return sliced;
      },
      async findUnique(args) {
        return store.syncRuns.find((r) => r.id === args.where.id) ?? null;
      },
      async count(args) {
        if (args?.where?.status === undefined) return store.syncRuns.length;
        const s = args.where.status;
        return store.syncRuns.filter((r) => (typeof s === 'string' ? r.status === s : s.in.includes(r.status))).length;
      },
    },

    syncError: {
      async create(args) {
        const row: SyncErrorRow = {
          id: fakeId('err'),
          syncRunId: args.data.syncRunId,
          externalId: args.data.externalId ?? null,
          url: args.data.url ?? null,
          stage: args.data.stage,
          errorType: args.data.errorType,
          message: args.data.message,
          stack: args.data.stack ?? null,
          retryCount: args.data.retryCount ?? 0,
          createdAt: now(),
        };
        store.syncErrors.push(row);
        return row;
      },
      async findMany(args) {
        let rows = [...store.syncErrors];
        if (args?.where?.syncRunId) rows = rows.filter((e) => e.syncRunId === args.where?.syncRunId);
        if (args?.where?.stage) rows = rows.filter((e) => e.stage === args.where?.stage);
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(args?.skip ?? 0, args?.take === undefined ? undefined : (args.skip ?? 0) + args.take);
      },
      async count(args) {
        let rows = [...store.syncErrors];
        if (args?.where?.syncRunId) rows = rows.filter((e) => e.syncRunId === args.where?.syncRunId);
        if (args?.where?.stage) rows = rows.filter((e) => e.stage === args.where?.stage);
        return rows.length;
      },
    },

    apiKey: {
      async findUnique(args) {
        const w = args.where as { keyHash?: string; name?: string };
        if (w.keyHash !== undefined) return store.apiKeys.find((k) => k.keyHash === w.keyHash) ?? null;
        return store.apiKeys.find((k) => k.name === w.name) ?? null;
      },
      async create(args) {
        const timestamp = now();
        const row: ApiKeyRow = {
          id: fakeId('key'),
          name: args.data.name,
          keyHash: args.data.keyHash,
          role: args.data.role,
          active: args.data.active ?? true,
          lastUsedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.apiKeys.push(row);
        return row;
      },
      async update(args) {
        const w = args.where as { id?: string; name?: string };
        const row = w.id ? store.apiKeys.find((k) => k.id === w.id) : store.apiKeys.find((k) => k.name === w.name);
        if (!row) throw new Error('ApiKey not found');
        Object.assign(row, args.data, { updatedAt: now() });
        return row;
      },
    },

    async $transaction(promises) {
      const results: unknown[] = [];
      for (const p of promises) {
        results.push(await p);
      }
      return results;
    },

    async $queryRaw<T>(query: TemplateStringsArray): Promise<T> {
      const text = query.join(' ');
      if (/SELECT 1/i.test(text)) return [{ '?column?': 1 }] as unknown as T;
      if (/pg_tables/i.test(text)) {
        // The memory provider always has the full schema.
        return [
          { tablename: 'Tender' },
          { tablename: 'TenderDocument' },
          { tablename: 'SyncRun' },
          { tablename: 'SyncError' },
          { tablename: 'ApiKey' },
        ] as unknown as T;
      }
      if (/unnest/i.test(text)) {
        const counts = new Map<string, number>();
        for (const tender of store.tenders) {
          for (const code of tender.cidbClass) {
            counts.set(code, (counts.get(code) ?? 0) + 1);
          }
        }
        const rows = [...counts.entries()]
          .map(([code, count]) => ({ class: code, count: BigInt(count) }))
          .sort((a, b) => Number(b.count - a.count));
        return rows as unknown as T;
      }
      throw new Error(`Unsupported raw query in fake DbClient: ${text.slice(0, 120)}`);
    },

    async $disconnect() {
      // no-op for the in-memory fake
    },
  };

  return { db, store };
}

// ─── Seed helpers ───────────────────────────────────────────────────────────

let seedCounter = 0;

export async function seedTender(db: DbClient, overrides: Partial<TenderCreateInput> = {}): Promise<TenderRow> {
  seedCounter += 1;
  return db.tender.create({
    data: {
      source: 'CIDB',
      externalId: overrides.externalId ?? `CIDB-TEST-${seedCounter}`,
      bidNumber: overrides.bidNumber ?? `TEST-${seedCounter}`,
      title: overrides.title ?? `Test tender ${seedCounter}`,
      description: overrides.description ?? `Description for test tender ${seedCounter}`,
      organisation: overrides.organisation ?? 'Construction Industry Development Board',
      province: overrides.province ?? 'Gauteng',
      location: overrides.location,
      municipality: overrides.municipality,
      tenderType: overrides.tenderType ?? 'Services',
      status: overrides.status ?? 'OPEN',
      publishedDate: overrides.publishedDate ?? new Date('2026-06-01T00:00:00.000Z'),
      closingDate: overrides.closingDate,
      briefingDate: overrides.briefingDate,
      briefingRequired: overrides.briefingRequired ?? false,
      briefingLocation: overrides.briefingLocation,
      cidbGrade: overrides.cidbGrade,
      cidbGradeRaw: overrides.cidbGradeRaw,
      cidbClass: overrides.cidbClass ?? [],
      cidbClassRaw: overrides.cidbClassRaw,
      estimatedValue: overrides.estimatedValue,
      contactName: overrides.contactName,
      contactEmail: overrides.contactEmail,
      contactPhone: overrides.contactPhone,
      sourceUrl: overrides.sourceUrl ?? 'https://www.cidb.org.za/cidb-tenders/current-tenders/',
      rawHash: overrides.rawHash ?? `hash-${seedCounter}`,
      rawData: overrides.rawData ?? { seed: seedCounter },
      documents: overrides.documents,
    },
  });
}

export async function seedApiKey(
  db: DbClient,
  options: { name: string; plaintext: string; role?: 'API' | 'ADMIN'; active?: boolean } = {
    name: 'test',
    plaintext: 'test-key',
  },
): Promise<ApiKeyRow> {
  return db.apiKey.create({
    data: {
      name: options.name,
      keyHash: hashApiKey(options.plaintext),
      role: options.role ?? 'API',
      active: options.active ?? true,
    },
  });
}
