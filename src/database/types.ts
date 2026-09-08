/**
 * Structural database types.
 *
 * These mirror the Prisma-generated shapes for our schema so application
 * code never depends on the generated client at compile time. In production
 * the real `PrismaClient` (a structural superset) is injected; in tests a
 * faithful in-memory implementation is injected instead.
 */

export type TenderStatus = 'OPEN' | 'CLOSING_SOON' | 'CLOSED' | 'CANCELLED' | 'AWARDED' | 'ARCHIVED' | 'UNKNOWN';
export type SyncStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
export type ApiKeyRole = 'API' | 'ADMIN';
export type DownloadStatus = 'NOT_DOWNLOADED' | 'PENDING' | 'DOWNLOADED' | 'FAILED';

/** Prisma returns Decimal objects; mocks may use number/string — all stringify. */
export interface DecimalLike {
  toString(): string;
}

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface TenderRow {
  id: string;
  source: string;
  externalId: string;
  bidNumber: string | null;
  title: string;
  description: string | null;
  organisation: string | null;
  province: string | null;
  location: string | null;
  municipality: string | null;
  tenderType: string | null;
  status: TenderStatus;
  publishedDate: Date | null;
  closingDate: Date | null;
  briefingDate: Date | null;
  briefingRequired: boolean;
  briefingLocation: string | null;
  cidbGrade: string | null;
  cidbGradeRaw: string | null;
  cidbClass: string[];
  cidbClassRaw: string | null;
  estimatedValue: DecimalLike | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  sourceUrl: string;
  rawHash: string;
  rawData: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenderDocumentRow {
  id: string;
  tenderId: string;
  name: string;
  documentType: string;
  url: string;
  sourceUrl: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  contentHash: string | null;
  downloadStatus: DownloadStatus;
  downloadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncRunRow {
  id: string;
  source: string;
  status: SyncStatus;
  startedAt: Date;
  completedAt: Date | null;
  recordsDiscovered: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsFailed: number;
  documentsFound: number;
  errorCount: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface SyncErrorRow {
  id: string;
  syncRunId: string;
  externalId: string | null;
  url: string | null;
  stage: string;
  errorType: string;
  message: string;
  stack: string | null;
  retryCount: number;
  createdAt: Date;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyHash: string;
  role: ApiKeyRole;
  active: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenderWithDocuments extends TenderRow {
  documents: TenderDocumentRow[];
}

// ─── Filter inputs (subset of Prisma filter API used by this project) ──────

export interface StringFilter {
  equals?: string;
  contains?: string;
  mode?: 'insensitive' | 'default';
  in?: string[];
  not?: string | null;
}

export interface DateFilter {
  gte?: Date;
  lte?: Date;
  gt?: Date;
  lt?: Date;
}

export interface TenderWhereInput {
  AND?: TenderWhereInput[];
  OR?: TenderWhereInput[];
  id?: string;
  source?: string;
  externalId?: string;
  bidNumber?: string | StringFilter | null;
  title?: StringFilter;
  description?: StringFilter;
  organisation?: StringFilter;
  province?: string | StringFilter | null;
  location?: StringFilter;
  municipality?: StringFilter;
  status?: TenderStatus | { in: TenderStatus[] };
  cidbGrade?: string | StringFilter | null;
  cidbClass?: { has: string };
  publishedDate?: DateFilter;
  closingDate?: DateFilter;
  lastSeenAt?: DateFilter;
}

export type TenderOrderByInput = Partial<
  Record<'publishedDate' | 'closingDate' | 'createdAt' | 'updatedAt' | 'bidNumber' | 'title', 'asc' | 'desc'>
>;

export interface DocumentCreateInput {
  name: string;
  documentType: string;
  url: string;
  sourceUrl: string;
  fileName?: string | null;
  mimeType?: string | null;
}

export interface TenderCreateInput {
  source: string;
  externalId: string;
  bidNumber?: string | null;
  title: string;
  description?: string | null;
  organisation?: string | null;
  province?: string | null;
  location?: string | null;
  municipality?: string | null;
  tenderType?: string | null;
  status: TenderStatus;
  publishedDate?: Date | null;
  closingDate?: Date | null;
  briefingDate?: Date | null;
  briefingRequired?: boolean;
  briefingLocation?: string | null;
  cidbGrade?: string | null;
  cidbGradeRaw?: string | null;
  cidbClass?: string[];
  cidbClassRaw?: string | null;
  estimatedValue?: number | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  sourceUrl: string;
  rawHash: string;
  rawData: unknown;
  lastSeenAt?: Date;
  documents?: { create: DocumentCreateInput[] };
}

export interface TenderUpdateInput extends Partial<Omit<TenderCreateInput, 'documents' | 'source' | 'externalId'>> {
  lastSeenAt?: Date;
  documents?: { create: DocumentCreateInput[] };
}

export interface SyncRunWhereInput {
  status?: SyncStatus | { in: SyncStatus[] };
}

export interface SyncErrorWhereInput {
  syncRunId?: string;
  stage?: string;
}

// ─── DbClient: the narrow data-access contract ──────────────────────────────

export interface FindManyArgs<W, O> {
  where?: W;
  orderBy?: O;
  skip?: number;
  take?: number;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
}

export interface TenderDelegate {
  count(args?: { where?: TenderWhereInput }): Promise<number>;
  findMany(args: FindManyArgs<TenderWhereInput, TenderOrderByInput>): Promise<TenderWithDocuments[]>;
  findFirst(
    args: FindManyArgs<TenderWhereInput, TenderOrderByInput>,
  ): Promise<TenderWithDocuments | TenderRow | null>;
  findUnique(args: {
    where: { id: string } | { source_externalId: { source: string; externalId: string } };
    select?: Record<string, boolean>;
    include?: Record<string, boolean>;
  }): Promise<TenderWithDocuments | TenderRow | null>;
  create(args: { data: TenderCreateInput; select?: Record<string, boolean> }): Promise<TenderRow>;
  update(args: { where: { id: string }; data: TenderUpdateInput }): Promise<TenderRow>;
  updateMany(args: { where?: TenderWhereInput; data: Partial<TenderRow> }): Promise<{ count: number }>;
  groupBy(args: {
    by: string[];
    _count: Record<string, boolean>;
    where?: TenderWhereInput;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<Array<Record<string, any>>>;
}

export interface TenderDocumentDelegate {
  count(args?: { where?: { tenderId?: string } }): Promise<number>;
  findMany(args: {
    where?: { tenderId?: string };
    orderBy?: Array<Record<string, 'asc' | 'desc'>>;
  }): Promise<TenderDocumentRow[]>;
  deleteMany(args: { where: { tenderId: string } }): Promise<{ count: number }>;
}

export interface SyncRunDelegate {
  create(args: { data: Partial<SyncRunRow> & { source: string } }): Promise<SyncRunRow>;
  update(args: { where: { id: string }; data: Partial<SyncRunRow> }): Promise<SyncRunRow>;
  findFirst(args?: {
    where?: SyncRunWhereInput;
    orderBy?: { startedAt: 'asc' | 'desc' };
    select?: Record<string, boolean>;
  }): Promise<SyncRunRow | null>;
  findMany(args?: {
    where?: SyncRunWhereInput;
    orderBy?: { startedAt: 'asc' | 'desc' };
    skip?: number;
    take?: number;
  }): Promise<SyncRunRow[]>;
  findUnique(args: { where: { id: string } }): Promise<SyncRunRow | null>;
  count(args?: { where?: SyncRunWhereInput }): Promise<number>;
}

export interface SyncErrorDelegate {
  create(args: {
    data: {
      syncRunId: string;
      externalId?: string | null;
      url?: string | null;
      stage: string;
      errorType: string;
      message: string;
      stack?: string | null;
      retryCount?: number;
    };
  }): Promise<SyncErrorRow>;
  findMany(args?: {
    where?: SyncErrorWhereInput;
    orderBy?: { createdAt: 'asc' | 'desc' };
    skip?: number;
    take?: number;
  }): Promise<SyncErrorRow[]>;
  count(args?: { where?: SyncErrorWhereInput }): Promise<number>;
}

export interface ApiKeyDelegate {
  findUnique(args: { where: { keyHash: string } | { name: string } }): Promise<ApiKeyRow | null>;
  create(args: { data: { name: string; keyHash: string; role: ApiKeyRole; active?: boolean } }): Promise<ApiKeyRow>;
  update(args: { where: { id: string } | { name: string }; data: Partial<ApiKeyRow> }): Promise<ApiKeyRow>;
}

export interface DbClient {
  tender: TenderDelegate;
  tenderDocument: TenderDocumentDelegate;
  syncRun: SyncRunDelegate;
  syncError: SyncErrorDelegate;
  apiKey: ApiKeyDelegate;
  $transaction(promises: Array<Promise<unknown>>): Promise<unknown[]>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $disconnect(): Promise<void>;
}
