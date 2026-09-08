import { z } from 'zod';
import { tenderStatusSchema } from './tender.js';

export const SORT_FIELDS = ['publishedDate', 'closingDate', 'createdAt', 'updatedAt', 'bidNumber', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

const dateString = (description: string) =>
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date format, expected ISO date string' })
    .describe(`${description} (ISO 8601, e.g. 2026-01-31 or 2026-01-31T00:00:00Z)`);

export const tenderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100.'),
  search: z
    .string()
    .max(200)
    .optional()
    .describe('Case-insensitive match on bid number, title, description, organisation and location.'),
  status: tenderStatusSchema.optional().describe('Display status filter. OPEN also includes CLOSING_SOON rows.'),
  province: z.string().max(100).optional().describe('Exact province, case-insensitive (e.g. Gauteng).'),
  cidbGrade: z
    .string()
    .max(20)
    .optional()
    .describe('CIDB contractor grade. A single grade also matches ranges containing it (6 matches 5-7).'),
  cidbClass: z.string().max(20).optional().describe('CIDB class of works code (e.g. GB, CE, ME).'),
  organisation: z.string().max(200).optional().describe('Case-insensitive partial match on the organisation.'),
  publishedFrom: dateString('Only tenders published on/after this date').optional(),
  publishedTo: dateString('Only tenders published on/before this date').optional(),
  closingFrom: dateString('Only tenders closing on/after this date').optional(),
  closingTo: dateString('Only tenders closing on/before this date').optional(),
  sort: z.enum(SORT_FIELDS).default('publishedDate').describe('Sort field.'),
  order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
});

export type TenderListQuery = z.infer<typeof tenderListQuerySchema>;

export const searchQuerySchema = z.object({
  q: z
    .string()
    .min(1)
    .max(200)
    .describe('Search text matched against bid number, title, description, organisation and location.'),
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100.'),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const closingSoonQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7).describe('Look-ahead window in days (1-365).'),
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100.'),
});

export type ClosingSoonQuery = z.infer<typeof closingSoonQuerySchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100.'),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
