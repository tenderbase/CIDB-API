import { config } from '../config.js';
import {
  TenderOrderByInput,
  TenderStatus,
  TenderWhereInput,
  TenderWithDocuments,
} from '../database/types.js';
import { DbClient, prisma } from '../database/client.js';
import { TenderListQuery } from '../schemas/query.js';
import { TenderStatusValue } from '../schemas/tender.js';

export interface TenderResponse {
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
  status: TenderStatusValue;
  publishedDate: string | null;
  closingDate: string | null;
  briefingDate: string | null;
  briefingRequired: boolean;
  briefingLocation: string | null;
  cidbGrade: string | null;
  cidbClass: string[];
  estimatedValue: string | null;
  contact: { name: string | null; email: string | null; phone: string | null };
  documents: Array<{
    id: string;
    name: string;
    documentType: string;
    url: string;
    fileName: string | null;
    mimeType: string | null;
  }>;
  sourceUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

type TenderWithDocs = TenderWithDocuments;

/**
 * Resolve the display status dynamically: stored OPEN/CLOSING_SOON rows are
 * re-evaluated against the current time so the API never reports a tender
 * as open after its closing date has passed. Terminal stored states are
 * returned untouched.
 */
export function resolveDisplayStatus(
  stored: TenderStatus,
  closingDate: Date | null,
  closingSoonDays = config.CLOSING_SOON_DAYS,
  now = new Date(),
): TenderStatusValue {
  if (stored === 'CLOSED' || stored === 'CANCELLED' || stored === 'AWARDED' || stored === 'ARCHIVED') {
    return stored;
  }
  if (!closingDate) return stored === 'UNKNOWN' ? 'UNKNOWN' : 'OPEN';
  const diffDays = (closingDate.getTime() - now.getTime()) / 86_400_000;
  if (diffDays < 0) return 'CLOSED';
  if (diffDays <= closingSoonDays) return 'CLOSING_SOON';
  return 'OPEN';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toTenderResponse(tender: TenderWithDocs): TenderResponse {
  return {
    id: tender.id,
    source: tender.source,
    externalId: tender.externalId,
    bidNumber: tender.bidNumber,
    title: tender.title,
    description: tender.description,
    organisation: tender.organisation,
    province: tender.province,
    location: tender.location,
    municipality: tender.municipality,
    tenderType: tender.tenderType,
    status: resolveDisplayStatus(tender.status, tender.closingDate),
    publishedDate: iso(tender.publishedDate),
    closingDate: iso(tender.closingDate),
    briefingDate: iso(tender.briefingDate),
    briefingRequired: tender.briefingRequired,
    briefingLocation: tender.briefingLocation,
    cidbGrade: tender.cidbGrade,
    cidbClass: tender.cidbClass,
    estimatedValue: tender.estimatedValue ? tender.estimatedValue.toString() : null,
    contact: { name: tender.contactName, email: tender.contactEmail, phone: tender.contactPhone },
    documents: tender.documents.map((d) => ({
      id: d.id,
      name: d.name,
      documentType: d.documentType,
      url: d.url,
      fileName: d.fileName,
      mimeType: d.mimeType,
    })),
    sourceUrl: tender.sourceUrl,
    firstSeenAt: tender.firstSeenAt.toISOString(),
    lastSeenAt: tender.lastSeenAt.toISOString(),
    createdAt: tender.createdAt.toISOString(),
    updatedAt: tender.updatedAt.toISOString(),
  };
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function paginate<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  return {
    data,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

function searchFilter(search: string): TenderWhereInput {
  return {
    OR: [
      { bidNumber: { contains: search, mode: 'insensitive' } },
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { organisation: { contains: search, mode: 'insensitive' } },
      { location: { contains: search, mode: 'insensitive' } },
      { municipality: { contains: search, mode: 'insensitive' } },
    ],
  };
}

/**
 * Status filter mapping. `OPEN` intentionally includes `CLOSING_SOON`
 * (both are still accepting submissions); every other value is exact.
 */
function statusFilter(status: TenderStatusValue): TenderWhereInput {
  if (status === 'OPEN') return { status: { in: ['OPEN', 'CLOSING_SOON'] } };
  return { status };
}

export function buildTenderWhere(query: TenderListQuery): TenderWhereInput {
  const where: TenderWhereInput = {};
  const and: TenderWhereInput[] = [];

  if (query.search?.trim()) and.push(searchFilter(query.search.trim()));
  if (query.status) and.push(statusFilter(query.status));
  if (query.province) and.push({ province: { equals: query.province, mode: 'insensitive' } });
  if (query.organisation) and.push({ organisation: { contains: query.organisation, mode: 'insensitive' } });
  if (query.cidbGrade) and.push({ cidbGrade: query.cidbGrade });
  if (query.cidbClass) and.push({ cidbClass: { has: query.cidbClass.toUpperCase() } });
  if (query.publishedFrom || query.publishedTo) {
    and.push({
      publishedDate: {
        ...(query.publishedFrom ? { gte: new Date(query.publishedFrom) } : {}),
        ...(query.publishedTo ? { lte: new Date(query.publishedTo) } : {}),
      },
    });
  }
  if (query.closingFrom || query.closingTo) {
    and.push({
      closingDate: {
        ...(query.closingFrom ? { gte: new Date(query.closingFrom) } : {}),
        ...(query.closingTo ? { lte: new Date(query.closingTo) } : {}),
      },
    });
  }
  if (and.length > 0) where.AND = and;
  return where;
}

export async function listTenders(
  query: TenderListQuery,
  db: DbClient = prisma,
): Promise<Paginated<TenderResponse>> {
  const where = buildTenderWhere(query);
  const orderBy: TenderOrderByInput = { [query.sort]: query.order };
  const [total, rows] = await Promise.all([
    db.tender.count({ where }),
    db.tender.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { documents: true },
    }),
  ]);
  return paginate(rows.map(toTenderResponse), total, query.page, query.limit);
}

export async function getTenderById(id: string, db: DbClient = prisma): Promise<TenderResponse | null> {
  const tender = (await db.tender.findFirst({
    // Accept either the internal id or the stable externalId.
    where: { OR: [{ id }, { externalId: id }] },
    include: { documents: true },
  })) as TenderWithDocuments | null;
  return tender ? toTenderResponse(tender) : null;
}

export async function closingSoonTenders(
  days: number,
  page: number,
  limit: number,
  db: DbClient = prisma,
): Promise<Paginated<TenderResponse>> {
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 86_400_000);
  const where: TenderWhereInput = {
    status: { in: ['OPEN', 'CLOSING_SOON', 'UNKNOWN'] },
    closingDate: { gte: now, lte: cutoff },
  };
  const [total, rows] = await Promise.all([
    db.tender.count({ where }),
    db.tender.findMany({
      where,
      orderBy: { closingDate: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { documents: true },
    }),
  ]);
  return paginate(rows.map(toTenderResponse), total, page, limit);
}

async function filteredList(
  where: TenderWhereInput,
  page: number,
  limit: number,
  db: DbClient,
): Promise<Paginated<TenderResponse>> {
  const [total, rows] = await Promise.all([
    db.tender.count({ where }),
    db.tender.findMany({
      where,
      orderBy: { publishedDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { documents: true },
    }),
  ]);
  return paginate(rows.map(toTenderResponse), total, page, limit);
}

export async function tendersByProvince(province: string, page: number, limit: number, db: DbClient = prisma) {
  return filteredList({ province: { equals: province, mode: 'insensitive' } }, page, limit, db);
}

export async function tendersByGrade(grade: string, page: number, limit: number, db: DbClient = prisma) {
  // Grade "6" also matches ranges containing 6, e.g. "5-7".
  const numeric = /^\d$/.exec(grade.trim());
  if (numeric) {
    const g = Number(numeric[0]);
    const ranges: string[] = [];
    for (let from = 1; from <= g; from++) {
      for (let to = g; to <= 9; to++) {
        if (from !== to) ranges.push(`${from}-${to}`);
      }
    }
    return filteredList({ OR: [{ cidbGrade: grade.trim() }, { cidbGrade: { in: ranges } }] }, page, limit, db);
  }
  return filteredList({ cidbGrade: grade }, page, limit, db);
}

export async function tendersByClass(classCode: string, page: number, limit: number, db: DbClient = prisma) {
  return filteredList({ cidbClass: { has: classCode.toUpperCase() } }, page, limit, db);
}
