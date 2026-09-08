/**
 * End-to-end ingestion test over a fixture captured from the CIDB's live
 * machine-readable feed (`tenders.json`): real feed mapper + real normalizer +
 * sync orchestration against the in-memory DbClient.
 *
 * This mirrors exactly what a production sync does against
 * CIDB_SOURCE_URL=https://www.cidb.org.za/tenders.json.
 */
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileFixtureConnector } from '../../src/cidb/fileConnector.js';
import { executeSyncRun, startSyncRun } from '../../src/services/syncService.js';
import { DbClient } from '../../src/database/types.js';
import { createMemoryDb } from '../helpers/fakeDb.js';

const LISTING_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
const FEED_URL = 'https://www.cidb.org.za/tenders.json';
const FEED_FIXTURE = join(__dirname, '..', 'fixtures', 'cidb-tenders.json');

let db: DbClient;

beforeEach(() => {
  db = createMemoryDb().db;
});

async function runSync() {
  // Replays a snapshot of the live feed: attribution stays on the public page,
  // the audit trail keeps the feed URL it came from.
  const connector = new FileFixtureConnector(`file:${FEED_FIXTURE}`, { feedUrl: FEED_URL });
  const syncId = await startSyncRun(db, 'CIDB');
  return executeSyncRun(syncId, { db, connector });
}

const allTenders = async () => db.tender.findMany({});
const allDocuments = async () => db.tenderDocument.findMany({});

describe('JSON feed sync', () => {
  it('ingests every feed entry (COMPLETED)', async () => {
    const summary = await runSync();
    expect(summary.status).toBe('COMPLETED');
    expect(summary.recordsDiscovered).toBe(5);
    expect(summary.recordsCreated).toBe(5);
    expect(summary.recordsFailed).toBe(0);
    expect(await db.tender.count()).toBe(5);
    expect(summary.documentsFound).toBeGreaterThan(0);
  });

  it('honours the source-declared status instead of inferring OPEN', async () => {
    await runSync();
    const tenders = await allTenders();
    const statuses = tenders.map((tender) => tender.status).sort();
    // The feed publishes no closing dates, so date inference alone would call
    // all five OPEN.
    expect(statuses).toEqual(['AWARDED', 'AWARDED', 'AWARDED', 'CLOSED', 'OPEN']);
    expect(tenders.every((tender) => tender.closingDate === null)).toBe(true);

    const awarded = tenders.find((tender) => tender.bidNumber === 'CIDB 004 2627');
    expect(awarded?.rawData).toMatchObject({ sourceStatus: 'AWARDED', sourceStatusRaw: 'Awarded' });
  });

  it('stores feed documents with inferred types, including links inside descriptions', async () => {
    await runSync();
    const documents = await allDocuments();
    const types = documents.map((document) => document.documentType);
    expect(types).toContain('BID_DOCUMENT');
    expect(types).toContain('ADDENDUM');
    expect(types).toContain('OPENING_REGISTER');
    expect(types).toContain('BRIEFING_NOTE');
    // Pulled out of the description HTML ("Click here to download the Pricing Schedule").
    expect(types).toContain('PRICING_SCHEDULE');
    expect(documents.every((document) => document.url.startsWith('https://www.cidb.org.za/'))).toBe(true);
    expect(documents.every((document) => document.sourceUrl === LISTING_URL)).toBe(true);
  });

  it('attributes records to the public listing page and keeps the feed URL in rawData', async () => {
    await runSync();
    const tenders = await allTenders();
    expect(tenders.every((tender) => tender.sourceUrl === LISTING_URL)).toBe(true);
    expect(tenders.every((tender) => tender.organisation === 'Construction Industry Development Board')).toBe(true);
    expect(tenders[0].rawData).toMatchObject({
      sourceExtra: expect.objectContaining({ feedUrl: FEED_URL, tenderId: expect.any(String) }),
    });
  });

  it('disambiguates duplicate bid numbers published by the feed', async () => {
    await runSync();
    const tenders = await allTenders();
    const duplicates = tenders.filter((tender) => tender.bidNumber === 'CIDB 010 2526');
    expect(duplicates).toHaveLength(2);
    const ids = duplicates.map((tender) => tender.externalId).sort();
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(new Set(tenders.map((tender) => tender.externalId)).size).toBe(5);
  });

  it('infers province from the description when region_name is a placeholder', async () => {
    await runSync();
    const tenders = await allTenders();
    const gauteng = tenders.find((tender) => tender.bidNumber === 'CIDB 004 2627');
    expect(gauteng?.province).toBe('Gauteng'); // "CIDB head office" is in Centurion
    const freeState = tenders.find((tender) => /CIDB 016 2425/.test(tender.bidNumber ?? ''));
    expect(freeState?.province).toBe('Free State'); // "Bloemfontein Regional Office"
  });

  it('is idempotent on a second sync', async () => {
    await runSync();
    const second = await runSync();
    expect(second.status).toBe('COMPLETED');
    expect(second.recordsCreated).toBe(0);
    expect(second.recordsUpdated).toBe(0);
    expect(second.recordsUnchanged).toBe(5);
    expect(await db.tender.count()).toBe(5);
  });
});
