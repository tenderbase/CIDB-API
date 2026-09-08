import { z } from 'zod';

export const syncHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Page size, 1-100.'),
  status: z
    .enum(['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'])
    .optional()
    .describe('Only return runs in this state.'),
});

export type SyncHistoryQuery = z.infer<typeof syncHistoryQuerySchema>;

export const errorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100.'),
  syncRunId: z.string().optional().describe('Only errors recorded by this sync run.'),
  stage: z.string().max(100).optional().describe('Only errors from this pipeline stage (e.g. FETCH, PARSE).'),
});

export type ErrorsQuery = z.infer<typeof errorsQuerySchema>;
