import { z } from 'zod';
import { tenderStatusSchema } from './tender.js';

/** Standard error envelope: { error: { code, message } }. */
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

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
