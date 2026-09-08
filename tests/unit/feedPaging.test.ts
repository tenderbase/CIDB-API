/**
 * Feed pagination tests.
 *
 * The CIDB feed is paginated server-side: the listing page requests
 * `tenders.json?page=&limit=&search_item=&region=&status=` and builds its pager
 * from `tender_count`. A single unparameterized request returns only the first
 * page (25 of 33 at the time of capture), so a sync that stops after one request
 * silently drops tenders. These tests drive `fetchFeedPages` with a stub
 * transport — no network — covering the ways the source can behave.
 */
import { describe, expect, it } from 'vitest';
import { CIDBJsonConnector, fetchFeedPages } from '../../src/cidb/jsonConnector.js';
import { CidbFeedEntry, dedupeFeedEntries, feedEntryKey, feedPageUrl } from '../../src/cidb/jsonFeed.js';

const FEED_URL = 'https://www.cidb.org.za/tenders.json';
const LISTING_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';

const entry = (id: number, overrides: Partial<CidbFeedEntry> = {}): CidbFeedEntry => ({
  tender_ID: String(id),
  bid_number: `cidb ${String(id).padStart(3, '0')} 2627`,
  description: `Tender ${id} description`,
  region_name: 'Tenders',
  realstatus: 'Awarded',
  status: 'active',
  ...overrides,
});

/** Stub source: `pages[n]` is what page n+1 returns (missing page → empty). */
function fakeSource(pages: CidbFeedEntry[][], declaredTotal: number | null) {
  const requested: string[] = [];
  return {
    requested,
    fetch: async (url: string) => {
      requested.push(url);
      const page = Number.parseInt(new URL(url).searchParams.get('page') ?? '1', 10);
      const rows = pages[page - 1] ?? [];
      const payload = {
        ...(declaredTotal === null ? {} : { tender_count: String(declaredTotal) }),
        tm_tenders: rows,
      };
      return { json: payload, raw: JSON.stringify(payload) };
    },
  };
}

describe('feedPageUrl', () => {
  it('sets page and limit while preserving the caller query', () => {
    expect(feedPageUrl(FEED_URL, { page: 2, limit: 100 })).toBe(`${FEED_URL}?page=2&limit=100`);
    // The site appends its own cache-buster (`?r=…`); keep it.
    expect(feedPageUrl(`${FEED_URL}?r=7223253`, { page: 3, limit: 25 })).toBe(
      `${FEED_URL}?r=7223253&page=3&limit=25`,
    );
    expect(feedPageUrl(FEED_URL)).toBe(FEED_URL);
  });
});

describe('feedEntryKey / dedupeFeedEntries', () => {
  it('identifies entries by tender_ID when present', () => {
    expect(feedEntryKey(entry(7))).toBe('id:7');
    expect(feedEntryKey(entry(7, { bid_number: 'different' }))).toBe('id:7');
  });

  it('falls back to bid number + description when there is no id', () => {
    const keyless: CidbFeedEntry = { bid_number: ' CIDB 010 2526 ', description: '<p>Same  work</p>' };
    expect(feedEntryKey(keyless)).toBe(feedEntryKey({ bid_number: 'cidb 010 2526', description: 'Same work' }));
    expect(feedEntryKey(keyless)).not.toBe(feedEntryKey({ bid_number: 'cidb 010 2526', description: 'Other work' }));
  });

  it('keeps the first occurrence of each entry', () => {
    expect(dedupeFeedEntries([entry(1), entry(2), entry(1, { description: 'changed' })])).toHaveLength(2);
  });
});

describe('fetchFeedPages', () => {
  it('walks every page until the declared total is reached', async () => {
    const source = fakeSource([Array.from({ length: 25 }, (_, i) => entry(i + 1)), Array.from({ length: 8 }, (_, i) => entry(i + 26))], 33);
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, pageSize: 25, delayMs: 0, fetch: source.fetch });

    expect(result.entries).toHaveLength(33);
    expect(result.declaredTotal).toBe(33);
    expect(result.pages.map((page) => [page.page, page.rows, page.newRows])).toEqual([
      [1, 25, 25],
      [2, 8, 8],
    ]);
    expect(result.warnings).toEqual([]);
    expect(source.requested).toEqual([`${FEED_URL}?page=1&limit=25`, `${FEED_URL}?page=2&limit=25`]);
  });

  it('stops when the source ignores paging and repeats the same page', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => entry(i + 1));
    const source = fakeSource([rows, rows, rows], 33);
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, pageSize: 25, delayMs: 0, fetch: source.fetch });

    expect(result.entries).toHaveLength(25);
    expect(source.requested).toHaveLength(2); // no infinite loop
    expect(result.warnings.join(' ')).toMatch(/paging parameters ignored/i);
    expect(result.warnings.join(' ')).toMatch(/33/);
  });

  it('stops at an empty page', async () => {
    const source = fakeSource([Array.from({ length: 10 }, (_, i) => entry(i + 1)), []], null);
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, pageSize: 10, delayMs: 0, fetch: source.fetch });

    expect(result.entries).toHaveLength(10);
    expect(result.pages.at(-1)).toMatchObject({ page: 2, rows: 0, newRows: 0 });
    expect(result.declaredTotal).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('merges overlapping pages without double-counting', async () => {
    // Page 2 re-serves the tail of page 1 (a shifting result set mid-walk).
    const source = fakeSource(
      [
        [entry(1), entry(2), entry(3)],
        [entry(3), entry(4), entry(5)],
      ],
      5,
    );
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, pageSize: 3, delayMs: 0, fetch: source.fetch });

    expect(result.entries.map((row) => row.tender_ID)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.pages[1]).toMatchObject({ rows: 3, newRows: 2 });
  });

  it('caps the walk at maxPages and says so', async () => {
    const source = fakeSource(
      Array.from({ length: 10 }, (_, page) => Array.from({ length: 5 }, (_, i) => entry(page * 5 + i + 1))),
      500,
    );
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, pageSize: 5, maxPages: 3, delayMs: 0, fetch: source.fetch });

    expect(result.entries).toHaveLength(15);
    expect(source.requested).toHaveLength(3);
    expect(result.warnings.join(' ')).toMatch(/CIDB_FEED_MAX_PAGES=3/);
    expect(result.warnings.join(' ')).toMatch(/15 of 500/);
  });

  it('reports zero entries (not a warning-free success) for an empty feed', async () => {
    const source = fakeSource([[]], 0);
    const result = await fetchFeedPages({ sourceUrl: FEED_URL, delayMs: 0, fetch: source.fetch });
    expect(result.entries).toHaveLength(0);
    expect(source.requested).toHaveLength(1);
  });

  it('honours an injected page size and logs each page', async () => {
    const source = fakeSource([[entry(1), entry(2)]], 2);
    const messages: string[] = [];
    await fetchFeedPages({
      sourceUrl: FEED_URL,
      pageSize: 2,
      delayMs: 0,
      fetch: source.fetch,
      log: (message) => messages.push(message),
    });
    expect(source.requested[0]).toBe(`${FEED_URL}?page=1&limit=2`);
    expect(messages[0]).toMatch(/Feed page 1: 2 rows \(2 new\)/);
  });
});

describe('CIDBJsonConnector over a paginated feed', () => {
  const rows = [
    entry(1, { realstatus: 'Open', tender_advert_date_time: '2026-06-01 17:35:25' }),
    entry(2, { realstatus: 'Awarded' }),
    entry(3, { realstatus: 'Closed' }),
  ];

  it('discovers records from every page, attributed to the public listing', async () => {
    const source = fakeSource([rows.slice(0, 2), rows.slice(2)], 3);
    const connector = new CIDBJsonConnector({
      sourceUrl: FEED_URL,
      pageSize: 2,
      delayMs: 0,
      fetcher: source.fetch,
    });

    const discovered = await connector.discover();
    expect(discovered).toHaveLength(3);
    expect(source.requested).toEqual([`${FEED_URL}?page=1&limit=2`, `${FEED_URL}?page=2&limit=2`]);
    // Attribution is the human page; the feed URL stays on the audit trail.
    expect(discovered.every((record) => record.sourceUrl === LISTING_URL)).toBe(true);

    const normalized = await Promise.all(
      discovered.map(async (record) => connector.normalize(await connector.parse(record))),
    );
    expect(normalized.map((tender) => tender.status).sort()).toEqual(['AWARDED', 'CLOSED', 'OPEN']);
    expect(normalized.every((tender) => tender.sourceUrl === LISTING_URL)).toBe(true);
    expect(normalized[0].rawData).toMatchObject({ sourceExtra: expect.objectContaining({ feedUrl: FEED_URL }) });
  });

  it('fails loudly instead of reporting "no tenders" when the feed is empty', async () => {
    const source = fakeSource([[]], 0);
    const connector = new CIDBJsonConnector({ sourceUrl: FEED_URL, delayMs: 0, fetcher: source.fetch });
    await expect(connector.discover()).rejects.toThrow(/SOURCE_STRUCTURE_CHANGED/);
  });

  it('reports page-1 rows against the declared total in its health check', async () => {
    const source = fakeSource([rows], 33);
    const connector = new CIDBJsonConnector({ sourceUrl: FEED_URL, pageSize: 25, delayMs: 0, fetcher: source.fetch });
    const health = await connector.healthCheck();
    expect(health).toMatchObject({ reachable: true });
    expect(health.detail).toContain('3 entries on page 1');
    expect(health.detail).toContain('33 declared');
  });
});
