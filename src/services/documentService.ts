import { DbClient, prisma } from '../database/client.js';

export interface TenderDocumentResponse {
  id: string;
  tenderId: string;
  name: string;
  documentType: string;
  url: string;
  sourceUrl: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  downloadStatus: string;
  downloadedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function tenderExists(tenderId: string, db: DbClient = prisma): Promise<boolean> {
  const count = await db.tender.count({ where: { OR: [{ id: tenderId }, { externalId: tenderId }] } });
  return count > 0;
}

export async function listDocumentsByTender(
  tenderId: string,
  db: DbClient = prisma,
): Promise<TenderDocumentResponse[] | null> {
  const tender = await db.tender.findFirst({
    where: { OR: [{ id: tenderId }, { externalId: tenderId }] },
    select: { id: true },
  });
  if (!tender) return null;
  const docs = await db.tenderDocument.findMany({
    where: { tenderId: tender.id },
    orderBy: [{ documentType: 'asc' }, { name: 'asc' }],
  });
  return docs.map((d) => ({
    id: d.id,
    tenderId: d.tenderId,
    name: d.name,
    documentType: d.documentType,
    url: d.url,
    sourceUrl: d.sourceUrl,
    fileName: d.fileName,
    mimeType: d.mimeType,
    fileSize: d.fileSize,
    downloadStatus: d.downloadStatus,
    downloadedAt: d.downloadedAt ? d.downloadedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));
}
