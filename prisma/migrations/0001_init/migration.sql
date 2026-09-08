-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('OPEN', 'CLOSING_SOON', 'CLOSED', 'CANCELLED', 'AWARDED', 'ARCHIVED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ApiKeyRole" AS ENUM ('API', 'ADMIN');

-- CreateEnum
CREATE TYPE "DownloadStatus" AS ENUM ('NOT_DOWNLOADED', 'PENDING', 'DOWNLOADED', 'FAILED');

-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CIDB',
    "externalId" TEXT NOT NULL,
    "bidNumber" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "organisation" TEXT,
    "province" TEXT,
    "location" TEXT,
    "municipality" TEXT,
    "tenderType" TEXT,
    "status" "TenderStatus" NOT NULL DEFAULT 'UNKNOWN',
    "publishedDate" TIMESTAMP(3),
    "closingDate" TIMESTAMP(3),
    "briefingDate" TIMESTAMP(3),
    "briefingRequired" BOOLEAN NOT NULL DEFAULT false,
    "briefingLocation" TEXT,
    "cidbGrade" TEXT,
    "cidbGradeRaw" TEXT,
    "cidbClass" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cidbClassRaw" TEXT,
    "estimatedValue" DECIMAL(18,2),
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderDocument" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'OTHER',
    "url" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "contentHash" TEXT,
    "downloadStatus" "DownloadStatus" NOT NULL DEFAULT 'NOT_DOWNLOADED',
    "downloadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenderDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CIDB',
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "recordsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "documentsFound" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncError" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "externalId" TEXT,
    "url" TEXT,
    "stage" TEXT NOT NULL,
    "errorType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "role" "ApiKeyRole" NOT NULL DEFAULT 'API',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tender_source_externalId_key" ON "Tender"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TenderDocument_tenderId_url_key" ON "TenderDocument"("tenderId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_name_key" ON "ApiKey"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "Tender_source_idx" ON "Tender"("source");

-- CreateIndex
CREATE INDEX "Tender_externalId_idx" ON "Tender"("externalId");

-- CreateIndex
CREATE INDEX "Tender_bidNumber_idx" ON "Tender"("bidNumber");

-- CreateIndex
CREATE INDEX "Tender_status_idx" ON "Tender"("status");

-- CreateIndex
CREATE INDEX "Tender_province_idx" ON "Tender"("province");

-- CreateIndex
CREATE INDEX "Tender_cidbGrade_idx" ON "Tender"("cidbGrade");

-- CreateIndex
CREATE INDEX "Tender_publishedDate_idx" ON "Tender"("publishedDate");

-- CreateIndex
CREATE INDEX "Tender_closingDate_idx" ON "Tender"("closingDate");

-- CreateIndex
CREATE INDEX "Tender_createdAt_idx" ON "Tender"("createdAt");

-- CreateIndex
CREATE INDEX "Tender_updatedAt_idx" ON "Tender"("updatedAt");

-- CreateIndex
CREATE INDEX "Tender_lastSeenAt_idx" ON "Tender"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TenderDocument_tenderId_idx" ON "TenderDocument"("tenderId");

-- CreateIndex
CREATE INDEX "TenderDocument_documentType_idx" ON "TenderDocument"("documentType");

-- CreateIndex
CREATE INDEX "SyncRun_source_idx" ON "SyncRun"("source");

-- CreateIndex
CREATE INDEX "SyncRun_status_idx" ON "SyncRun"("status");

-- CreateIndex
CREATE INDEX "SyncRun_startedAt_idx" ON "SyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_createdAt_idx" ON "SyncRun"("createdAt");

-- CreateIndex
CREATE INDEX "SyncError_syncRunId_idx" ON "SyncError"("syncRunId");

-- CreateIndex
CREATE INDEX "SyncError_stage_idx" ON "SyncError"("stage");

-- CreateIndex
CREATE INDEX "SyncError_errorType_idx" ON "SyncError"("errorType");

-- CreateIndex
CREATE INDEX "SyncError_createdAt_idx" ON "SyncError"("createdAt");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_active_idx" ON "ApiKey"("active");

-- AddForeignKey
ALTER TABLE "TenderDocument" ADD CONSTRAINT "TenderDocument_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncError" ADD CONSTRAINT "SyncError_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
