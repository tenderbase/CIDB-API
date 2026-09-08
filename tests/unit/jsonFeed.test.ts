/**
 * CIDB machine-readable feed (`tenders.json`) mapping tests, using a fixture
 * captured from the live feed (tests/fixtures/cidb-tenders.json).
 *
 * The public listing page renders its rows in the browser from this feed, so
 * the feed — not the served HTML — is the authoritative source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractFeedEntries,
  mapFeedStatus,
  parseDescriptionHtml,
  parseTendersJson,
  probeTendersJson,
} from '../../src/cidb/jsonFeed.js';
import { ensureUniqueExternalIds, normalizeParsedTender } from '../../src/cidb/normalizer.js';

const FEED_URL = 'https://www.cidb.org.za/tenders.json';
const LISTING_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
const feed = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'cidb-tenders.json'), 'utf8')) as unknown;

const parsed = parseTendersJson(feed, LISTING_URL);
const byBid = (bid: string) => parsed.filter((record) => record.bidNumber === bid);

describe('feed probing', () => {
  it('reports entry counts and the feed-declared total', () => {
    const probe = probeTendersJson(feed);
    expect(probe.found).toBe(true);
    expect(probe.rowCount).toBe(5);
    expect(probe.declaredCount).toBe('5');
  });

  it('accepts a bare array and a renamed wrapper', () => {
    expect(extractFeedEntries([{ bid_number: 'x' }])).toHaveLength(1);
    expect(extractFeedEntries({ tenders: [{ bid_number: 'x' }, { bid_number: 'y' }] })).toHaveLength(2);
    expect(extractFeedEntries(null)).toHaveLength(0);
    expect(extractFeedEntries('not a feed')).toHaveLength(0);
    expect(probeTendersJson({ tm_tenders: [] }).found).toBe(false);
  });
});

describe('status mapping', () => {
  it('maps the source-declared realstatus onto schema statuses', () => {
    expect(mapFeedStatus('Awarded')).toBe('AWARDED');
    expect(mapFeedStatus('closed')).toBe('CLOSED');
    expect(mapFeedStatus(' Open ')).toBe('OPEN');
    expect(mapFeedStatus('Open for Bidding')).toBe('OPEN');
    expect(mapFeedStatus('cancelled')).toBe('CANCELLED');
    expect(mapFeedStatus('nonsense')).toBeNull();
    expect(mapFeedStatus(undefined)).toBeNull();
  });

  it('keeps source-declared terminal statuses instead of inferring OPEN', () => {
    // The feed publishes no closing dates, so inference alone would call
    // every record OPEN — the source says otherwise.
    const statuses = parsed.map((record) => normalizeParsedTender(record).status);
    expect(statuses).toContain('AWARDED');
    expect(statuses).toContain('CLOSED');
    expect(statuses).toContain('OPEN');
    expect(statuses.filter((status) => status === 'OPEN').length).toBe(1);
  });
});

describe('field mapping', () => {
  it('trims and preserves the bid number', () => {
    const record = byBid('cidb 004 2627')[0];
    expect(record.bidNumber).toBe('cidb 004 2627');
    expect(record.extra.bidNumberRaw).toBe(' cidb 004 2627'); // leading space in the feed
    expect(normalizeParsedTender(record).bidNumber).toBe('CIDB 004 2627');
  });

  it('maps the advertised datetime to publishedDate', () => {
    const record = byBid('cidb 004 2627')[0];
    expect(record.publishedDate).toBe('2026-06-01 17:35:25');
    expect(normalizeParsedTender(record).publishedDate?.toISOString()).toBe('2026-06-01T17:35:25.000Z');
  });

  it('treats the feed zero-date as null', () => {
    const mapped = parseTendersJson(
      { tm_tenders: [{ bid_number: 'cidb 000 0000', description: 'x', tender_advert_date_time: '0000-00-00 00:00:00' }] },
      LISTING_URL,
    );
    expect(mapped[0].publishedDate).toBeNull();
  });

  it('does not mistake region_name "Tenders" for a location', () => {
    expect(parsed.every((record) => record.locationText === null)).toBe(true);
  });

  it('carries source identifiers in extra for the audit trail', () => {
    const record = byBid('cidb 004 2627')[0];
    expect(record.extra).toMatchObject({
      tenderId: '46',
      sourceStatus: 'AWARDED',
      sourceStatusRaw: 'Awarded',
      feedStatus: 'active',
      feedUrl: LISTING_URL,
    });
    expect(record.extra.awardsDateTime).toBe('2026-06-29 12:58:56');
  });
});

describe('documents', () => {
  it('labels feed files exactly like the website buttons', () => {
    const full = byBid('cidb 005 2627')[0]; // advert + specification + awards + briefing
    expect(full.documents.map((document) => document.label)).toEqual([
      'GET BID DOCUMENT',
      'GET ADDENDUM',
      'BID OPENING REGISTER',
      'BRIEFING NOTE',
    ]);
    const normalized = normalizeParsedTender(full);
    expect(normalized.documents.map((document) => document.documentType)).toEqual([
      'BID_DOCUMENT',
      'ADDENDUM',
      'OPENING_REGISTER',
      'BRIEFING_NOTE',
    ]);
    expect(normalized.documents.every((document) => document.url.startsWith('https://www.cidb.org.za/'))).toBe(true);
    expect(normalized.documents[0].mimeType).toBe('application/pdf');
  });

  it('skips empty file fields', () => {
    const record = byBid('cidb 016 2425')[0]; // no awards, no briefing
    expect(record.documents.map((document) => document.label)).toEqual(['GET BID DOCUMENT', 'GET ADDENDUM']);
  });

  it('extracts documents linked from inside the description HTML', () => {
    const record = byBid('cidb 004 2627')[0];
    const pricing = record.documents.find((document) => /Annexure-B/i.test(document.url));
    expect(pricing?.url).toMatch(/\.xlsx$/i);
    const normalized = normalizeParsedTender(record);
    expect(normalized.documents.map((document) => document.documentType)).toContain('PRICING_SCHEDULE');
    expect(normalized.documents.find((document) => document.documentType === 'PRICING_SCHEDULE')?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('strips markup from the description but keeps its text', () => {
    const { text } = parseDescriptionHtml(
      'Works at <b>head office</b>.<a href="/wp-content/uploads/x.xlsx">Click here</a> for the BOQ.',
      FEED_URL,
    );
    expect(text).toBe('Works at head office.Click here for the BOQ.');
    const record = byBid('cidb 004 2627')[0];
    expect(record.description).not.toMatch(/<a\s|href=/i);
    expect(record.description).toMatch(/Click here to download the Pricing Schedule\./);
  });

  it('resolves relative links against the feed origin and drops junk hrefs', () => {
    const { documents } = parseDescriptionHtml(
      '<a href="/wp-content/uploads/a.pdf">A</a><a href="#">skip</a><a href="javascript:void(0)">skip</a><a>no href</a>',
      FEED_URL,
    );
    expect(documents).toHaveLength(1);
    expect(documents[0].url).toBe('https://www.cidb.org.za/wp-content/uploads/a.pdf');
  });
});

describe('pipeline parity', () => {
  it('normalizes every feed entry into the tender schema', () => {
    const normalized = parsed.map((record) => normalizeParsedTender(record));
    expect(normalized).toHaveLength(5);
    for (const tender of normalized) {
      expect(tender.source).toBe('CIDB');
      expect(tender.externalId).toMatch(/^CIDB-/);
      expect(tender.organisation).toBe('Construction Industry Development Board');
      expect(tender.sourceUrl).toBe(LISTING_URL);
      expect(tender.rawHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('suffixes duplicate bid numbers deterministically', () => {
    const normalized = parsed.map((record) => normalizeParsedTender(record));
    const duplicates = normalized.filter((tender) => tender.bidNumber === 'CIDB 010 2526');
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].externalId).toBe(duplicates[1].externalId);

    const unique = ensureUniqueExternalIds(normalized);
    const ids = unique.filter((tender) => tender.bidNumber === 'CIDB 010 2526').map((tender) => tender.externalId);
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(new Set(unique.map((tender) => tender.externalId)).size).toBe(unique.length);
  });

  it('keeps attribution on the public listing page, with the feed URL in rawData', () => {
    const normalized = normalizeParsedTender(parsed[0]);
    expect(normalized.sourceUrl).toBe(LISTING_URL);
    expect(normalized.rawData).toMatchObject({
      sourceStatusRaw: 'Awarded',
      sourceExtra: expect.objectContaining({ feedUrl: LISTING_URL, tenderId: '46' }),
    });
  });

  it('drops entries with no usable content', () => {
    expect(parseTendersJson({ tm_tenders: [{ bid_number: '  ', description: '   ' }] }, LISTING_URL)).toHaveLength(0);
  });
});
