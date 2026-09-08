import { z } from 'zod';
import { tenderStatusSchema } from './tender.js';

/** Standard error envelope: { error: { code, message } }. */
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Documented error schemas.
 *
 * The `.describe()` text becomes the OpenAPI *response* description, i.e. what
 * Swagger UI prints next to each status code. Without it every response in the
 * docs is rendered as the meaningless "Default Response".
 */
export const badRequestErrorSchema = errorSchema.describe(
  'Bad request — a query or path parameter failed validation.',
);
export const unauthorizedErrorSchema = errorSchema.describe(
  'Unauthorized — the `X-API-Key` header is missing, unknown or inactive.',
);
export const forbiddenErrorSchema = errorSchema.describe(
  'Forbidden — the key is valid but does not have the ADMIN role.',
);
export const notFoundErrorSchema = errorSchema.describe('Not found — no resource matches the request.');
export const conflictErrorSchema = errorSchema.describe('Conflict — a synchronization is already running.');
export const rateLimitedErrorSchema = errorSchema.describe(
  'Too many requests — the rate limit was exceeded; retry after the window resets.',
);
export const unavailableErrorSchema = errorSchema.describe('Service unavailable — the database is unreachable.');

/** Error responses shared by every authenticated route (401 + 429). */
export const authedErrorResponses = {
  401: unauthorizedErrorSchema,
  429: rateLimitedErrorSchema,
} as const;

/** Error responses shared by every admin route (401 + 403 + 429). */
export const adminErrorResponses = {
  401: unauthorizedErrorSchema,
  403: forbiddenErrorSchema,
  429: rateLimitedErrorSchema,
} as const;

const documentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  documentType: z.string(),
  url: z.string(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
});

export const tenderResponseSchema = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  bidNumber: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  organisation: z.string().nullable(),
  province: z.string().nullable(),
  location: z.string().nullable(),
  municipality: z.string().nullable(),
  tenderType: z.string().nullable(),
  status: tenderStatusSchema,
  publishedDate: z.string().nullable(),
  closingDate: z.string().nullable(),
  briefingDate: z.string().nullable(),
  briefingRequired: z.boolean(),
  briefingLocation: z.string().nullable(),
  cidbGrade: z.string().nullable(),
  cidbClass: z.array(z.string()),
  estimatedValue: z.string().nullable(),
  contact: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  documents: z.array(documentSummarySchema),
  sourceUrl: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  });
}

export const tenderListResponseSchema = paginatedSchema(tenderResponseSchema);

export const documentResponseSchema = z.object({
  id: z.string(),
  tenderId: z.string(),
  name: z.string(),
  documentType: z.string(),
  url: z.string(),
  sourceUrl: z.string(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileSize: z.number().nullable(),
  downloadStatus: z.string(),
  downloadedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const tenderDocumentsResponseSchema = z.array(documentResponseSchema);

export const statsResponseSchema = z.object({
  totalTenders: z.number(),
  openTenders: z.number(),
  closingSoon: z.number(),
  closedTenders: z.number(),
  lastSync: z.string().nullable(),
  lastSuccessfulSync: z.string().nullable(),
  recordsAddedLastSync: z.number(),
  recordsUpdatedLastSync: z.number(),
  byProvince: z.array(z.object({ province: z.string(), count: z.number() })),
  byGrade: z.array(z.object({ grade: z.string(), count: z.number() })),
  byClass: z.array(z.object({ class: z.string(), count: z.number() })),
});

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  database: z.string(),
  timestamp: z.string(),
});

export const detailedHealthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  timestamp: z.string(),
  database: z.object({ connected: z.boolean(), latencyMs: z.number() }),
  source: z.object({
    url: z.string(),
    reachable: z.boolean(),
    latencyMs: z.number().nullable(),
    detail: z.string().nullable(),
  }),
  worker: z.object({
    lastSyncAt: z.string().nullable(),
    lastSyncStatus: z.string().nullable(),
    lastSyncDurationMs: z.number().nullable(),
    lastSuccessfulSyncAt: z.string().nullable(),
    runningSync: z.boolean(),
  }),
  records: z.object({ totalTenders: z.number(), totalDocuments: z.number() }),
});

export const syncRunSchema = z.object({
  id: z.string(),
  source: z.string(),
  status: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  recordsDiscovered: z.number(),
  recordsCreated: z.number(),
  recordsUpdated: z.number(),
  recordsUnchanged: z.number(),
  recordsFailed: z.number(),
  documentsFound: z.number(),
  errorCount: z.number(),
  durationMs: z.number().nullable(),
  errorMessage: z.string().nullable(),
});

export const syncErrorSchema = z.object({
  id: z.string(),
  syncRunId: z.string(),
  externalId: z.string().nullable(),
  url: z.string().nullable(),
  stage: z.string(),
  errorType: z.string(),
  message: z.string(),
  retryCount: z.number(),
  createdAt: z.string(),
});

export const syncDetailResponseSchema = syncRunSchema.extend({
  recentErrors: z.array(syncErrorSchema),
});

export const syncStartResponseSchema = z.object({
  status: z.string(),
  syncId: z.string(),
});

export const syncHistoryResponseSchema = paginatedSchema(syncRunSchema);
export const syncErrorsResponseSchema = paginatedSchema(syncErrorSchema);

/**
 * Documented success schemas — same shapes as above, each carrying the
 * description Swagger UI shows for the 200/202 response.
 */
export const tenderListOkSchema = tenderListResponseSchema.describe('Paginated tenders matching the request.');
export const tenderOkSchema = tenderResponseSchema.describe('Full tender detail, including its documents.');
export const tenderDocumentsOkSchema = tenderDocumentsResponseSchema.describe('Documents attached to the tender.');
export const statsOkSchema = statsResponseSchema.describe('Aggregate counts, sync freshness and breakdowns.');
export const healthOkSchema = healthResponseSchema.describe('Service is up and the database answered.');
export const healthDegradedSchema = healthResponseSchema.describe('Service is up but the database is unreachable.');
export const detailedHealthOkSchema = detailedHealthResponseSchema.describe(
  'Database, source, worker and record-count diagnostics.',
);
export const syncAcceptedSchema = syncStartResponseSchema.describe(
  'Sync accepted and running in the background; poll GET /admin/sync/{id} for progress.',
);
export const syncHistoryOkSchema = syncHistoryResponseSchema.describe('Recent synchronization runs, newest first.');
export const syncDetailOkSchema = syncDetailResponseSchema.describe(
  'One synchronization run with its counters and most recent errors.',
);
export const syncErrorsOkSchema = syncErrorsResponseSchema.describe('Recent ingestion errors, newest first.');
