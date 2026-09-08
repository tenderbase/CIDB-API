import { z } from 'zod';
import { tenderStatusSchema } from './tender.js';

export const SORT_FIELDS = ['publishedDate', 'closingDate', 'createdAt', 'updatedAt', 'bidNumber', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

const dateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date format, expected ISO date string' });

export const tenderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  status: tenderStatusSchema.optional(),
  province: z.string().max(100).optional(),
  cidbGrade: z.string().max(20).optional(),
  cidbClass: z.string().max(20).optional(),
  organisation: z.string().max(200).optional(),
  publishedFrom: dateString.optional(),
  publishedTo: dateString.optional(),
  closingFrom: dateString.optional(),
  closingTo: dateString.optional(),
  sort: z.enum(SORT_FIELDS).default('publishedDate'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type TenderListQuery = z.infer<typeof tenderListQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const closingSoonQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ClosingSoonQuery = z.infer<typeof closingSoonQuerySchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
