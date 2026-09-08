import { z } from 'zod';

export const tenderStatusSchema = z.enum([
  'OPEN',
  'CLOSING_SOON',
  'CLOSED',
  'CANCELLED',
  'AWARDED',
  'ARCHIVED',
  'UNKNOWN',
]);

export type TenderStatusValue = z.infer<typeof tenderStatusSchema>;

/** Validated shape of a normalized tender produced by the ingestion pipeline. */
export const normalizedTenderSchema = z.object({
  source: z.string().min(1).default('CIDB'),
  externalId: z.string().min(1),
  bidNumber: z.string().nullable().default(null),
  title: z.string().min(1),
  description: z.string().nullable().default(null),
  organisation: z.string().nullable().default(null),
  province: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  municipality: z.string().nullable().default(null),
  tenderType: z.string().nullable().default(null),
  status: tenderStatusSchema.default('UNKNOWN'),
  publishedDate: z.date().nullable().default(null),
  closingDate: z.date().nullable().default(null),
  briefingDate: z.date().nullable().default(null),
  briefingRequired: z.boolean().default(false),
  briefingLocation: z.string().nullable().default(null),
  cidbGrade: z.string().nullable().default(null),
  cidbGradeRaw: z.string().nullable().default(null),
  cidbClass: z.array(z.string()).default([]),
  cidbClassRaw: z.string().nullable().default(null),
  estimatedValue: z.number().nullable().default(null),
  contactName: z.string().nullable().default(null),
  contactEmail: z.string().email().nullable().default(null),
  contactPhone: z.string().nullable().default(null),
  sourceUrl: z.string().url(),
  rawHash: z.string().min(1),
  rawData: z.record(z.unknown()),
  documents: z
    .array(
      z.object({
        name: z.string().min(1),
        documentType: z.string().min(1),
        url: z.string().url(),
        sourceUrl: z.string().url(),
        fileName: z.string().nullable().default(null),
        mimeType: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type NormalizedTender = z.infer<typeof normalizedTenderSchema>;
