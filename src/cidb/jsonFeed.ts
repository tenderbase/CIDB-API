import * as cheerio from 'cheerio';
import { TenderStatusValue } from '../schemas/tender.js';
import { DiscoveredDocument, ParsedTender } from './types.js';

/**
 * Mapping for the CIDB machine-readable tender feed.
 *
 * The public listing (https://www.cidb.org.za/cidb-tenders/current-tenders/)
 * ships an EMPTY `<tbody>`: its rows are rendered in the browser by
 * `loadDataTable()`, which fetches `https://www.cidb.org.za/tenders.json` and
 * builds the same four columns this project's HTML parser expects
 * (Bid Number · Details · Date · Documents). Scraping the served HTML therefore
 * finds a correct table with zero rows. This module consumes that feed directly,
 * which is both complete (no pagination — one payload holds every record) and
 * richer: it carries `realstatus` (Open/Awarded/Closed), tender ids, per-document
 * timestamps and links embedded inside the description HTML.
 *
 * Feed entry fields observed in production (all strings unless noted):
 *   tender_ID, user_ID, region, region_name, description (HTML), bid_number,
 *   tender_advert_file / _date_time / _file_link,
 *   tender_specification_file / _date_time / _file_link,
 *   tender_awards_file / _date_time / _file_link,
 *   tender_briefing_file / _file_link,
 *   status ("active"), realstatus ("Open"|"Awarded"|"Closed"), row_num (number),
 *   tr_class, tender_checkbox (HTML), fullarray (boolean)
 */

export interface CidbFeedEntry {
  tender_ID?: string | number;
  user_ID?: string | number;
  region?: string | number;
  region_name?: string;
  description?: string;
  bid_number?: string;
  tender_advert_file?: string;
  tender_advert_date_time?: string;
  tender_specification_file?: string;
  tender_specification_date_time?: string;
  tender_awards_file?: string;
  tender_awards_date_time?: string;
  tender_briefing_file?: string;
  status?: string;
  realstatus?: string;
  row_num?: number | string;
  [key: string]: unknown;
}

export interface CidbFeed {
  tender_count?: string | number;
  tm_tenders?: CidbFeedEntry[];
}

/** Source status → schema status. The source states these, so they are never inferred. */
const FEED_STATUS_MAP: Record<string, TenderStatusValue> = {
  open: 'OPEN',
  'open for bidding': 'OPEN',
  awarded: 'AWARDED',
  closed: 'CLOSED',
  'closed for bidding': 'CLOSED',
  cancelled: 'CANCELLED',
  archived: 'ARCHIVED',
};

export function mapFeedStatus(raw: unknown): TenderStatusValue | null {
  if (typeof raw !== 'string') return null;
  return FEED_STATUS_MAP[raw.trim().toLowerCase()] ?? null;
}

/** Extract the tender rows from a feed payload (`{tm_tenders: []}` or a bare array). */
export function extractFeedEntries(payload: unknown): CidbFeedEntry[] {
  if (Array.isArray(payload)) return payload as CidbFeedEntry[];
  if (payload && typeof payload === 'object') {
    const feed = payload as CidbFeed;
    if (Array.isArray(feed.tm_tenders)) return feed.tm_tenders;
    // Tolerate a renamed wrapper (e.g. {tenders: [...]}).
    for (const value of Object.values(feed)) {
      if (Array.isArray(value)) return value as CidbFeedEntry[];
    }
  }
  return [];
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : null;
};

/** "0000-00-00 00:00:00" and empty strings are the feed's null date. */
const dateTime = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw || /^0000-00-00/.test(raw)) return null;
  return raw;
};

/**
 * Description HTML → plain text plus any documents linked from inside it
 * (pricing schedules, addenda, annexures the editors inline as anchors).
 */
export function parseDescriptionHtml(html: string | null, sourceUrl: string): {
  text: string | null;
  documents: DiscoveredDocument[];
} {
  if (!html) return { text: null, documents: [] };
  const $ = cheerio.load(html);
  const documents: DiscoveredDocument[] = [];
  $('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href')?.trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return;
    let absolute: string;
    try {
      absolute = new URL(href, sourceUrl).toString();
    } catch {
      return;
    }
    const label = $(anchor).text().replace(/\s+/g, ' ').trim() || null;
    documents.push({ name: label ?? absolute, url: absolute, label });
  });

  // Keep line breaks so multi-paragraph details stay readable, then drop markup.
  $('br').replaceWith('\n');
  const plain = $('body')
    .text()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\r/g, '')
    .trim();
  return { text: plain || null, documents };
}

function feedDocument(url: unknown, label: string, sourceUrl: string): DiscoveredDocument | null {
  const raw = text(url);
  if (!raw) return null;
  let absolute: string;
  try {
    absolute = new URL(raw, sourceUrl).toString();
  } catch {
    return null;
  }
  return { name: label, url: absolute, label };
}

/**
 * One feed entry → the same ParsedTender shape the HTML parser produces.
 *
 * `feedUrl` is where the data came from; `attributionUrl` (defaults to the same)
 * is the human-facing page records are attributed to.
 */
export function mapFeedEntry(entry: CidbFeedEntry, feedUrl: string, attributionUrl: string = feedUrl): ParsedTender | null {
  const description = parseDescriptionHtml(typeof entry.description === 'string' ? entry.description : null, feedUrl);
  const bidNumber = text(entry.bid_number);

  // Labels mirror the buttons the CIDB site renders, so document classification
  // (BID_DOCUMENT / ADDENDUM / OPENING_REGISTER / BRIEFING_NOTE) stays identical.
  const documents: DiscoveredDocument[] = [
    feedDocument(entry.tender_advert_file, 'GET BID DOCUMENT', feedUrl),
    feedDocument(entry.tender_specification_file, 'GET ADDENDUM', feedUrl),
    feedDocument(entry.tender_awards_file, 'BID OPENING REGISTER', feedUrl),
    feedDocument(entry.tender_briefing_file, 'BRIEFING NOTE', feedUrl),
    ...description.documents,
  ].filter((document): document is DiscoveredDocument => document !== null);

  const regionName = text(entry.region_name);
  const advertDateTime = dateTime(entry.tender_advert_date_time);
  if (!bidNumber && !description.text && documents.length === 0) return null;

  return {
    bidNumber,
    title: null, // derived from the description by the normalizer
    description: description.text,
    organisation: null, // the feed is CIDB-only; the normalizer applies the default
    publishedDate: advertDateTime,
    // The feed publishes no closing date; the normalizer still scans the
    // description for "closing date …" wording when editors include it.
    closingDate: null,
    // region_name is "Tenders" on the current listing — not a place. Keep it
    // only when it actually names a region.
    locationText: regionName && !/^tenders$/i.test(regionName) ? regionName : null,
    documents,
    sourceUrl: attributionUrl,
    extra: {
      sourceStatus: mapFeedStatus(entry.realstatus),
      sourceStatusRaw: text(entry.realstatus),
      feedStatus: text(entry.status),
      tenderId: text(entry.tender_ID ?? entry.tender_id),
      userId: text(entry.user_ID ?? entry.user_id),
      region: text(entry.region),
      regionName,
      rowNum: typeof entry.row_num === 'number' ? entry.row_num : Number.parseInt(String(entry.row_num ?? ''), 10) || null,
      bidNumberRaw: typeof entry.bid_number === 'string' ? entry.bid_number : null,
      dateRaw: advertDateTime,
      specificationDateTime: dateTime(entry.tender_specification_date_time),
      awardsDateTime: dateTime(entry.tender_awards_date_time),
      feedUrl,
    },
  };
}

/** Feed payload → parsed tenders (entries without any usable content are dropped). */
export function parseTendersJson(payload: unknown, feedUrl: string, attributionUrl: string = feedUrl): ParsedTender[] {
  return extractFeedEntries(payload)
    .map((entry) => mapFeedEntry(entry, feedUrl, attributionUrl))
    .filter((parsed): parsed is ParsedTender => parsed !== null);
}

/** Structure probe used by health checks: is this still the feed we expect? */
export function probeTendersJson(payload: unknown): { found: boolean; rowCount: number; declaredCount: string | null } {
  const entries = extractFeedEntries(payload);
  const declared =
    payload && typeof payload === 'object' && 'tender_count' in (payload as CidbFeed)
      ? text((payload as CidbFeed).tender_count)
      : null;
  return { found: entries.length > 0, rowCount: entries.length, declaredCount: declared };
}
