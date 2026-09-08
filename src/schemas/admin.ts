import { z } from 'zod';

export const syncHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']).optional(),
});

export type SyncHistoryQuery = z.infer<typeof syncHistoryQuerySchema>;

export const errorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  syncRunId: z.string().optional(),
  stage: z.string().max(100).optional(),
});

export type ErrorsQuery = z.infer<typeof errorsQuerySchema>;
