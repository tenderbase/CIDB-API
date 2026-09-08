/**
 * Ingest every tender currently published by CIDB and write the normalized
 * dataset to disk — without touching a database.
 *
 *   npm run ingest:export                       # live CIDB feed (all records)
 *   npx tsx scripts/ingest-export.ts --out=data --raw=artifacts/cidb-source
 *   npx tsx scripts/ingest-export.ts --url=https://www.cidb.org.za/cidb-tenders/current-tenders/
 *   npx tsx scripts/ingest-export.ts --url=file:./snapshots/<stamp>/source-html/tenders.json --raw=none
 *
 * Runs the exact production pipeline (fetch → parse → normalizeParsedTender →
 * ensureUniqueExternalIds), so the output matches what a sync writes.
 *
 * Three source shapes are supported:
 *   • JSON feed (default, `…/tenders.json`) — what the public listing page
 *     renders from. It is paginated server-side (`?page=&limit=`, total in
 *     `tender_count`), so every page is walked: `--limit` sets the page size
 *     (the site offers 10/25/50/100), `--max-pages` caps the walk.
 *   • HTML listing — parsed with the same table parser as production and
 *     followed across pagination links (`--max-pages`).
 *   • `file:<path>` — offline replay of a captured feed or listing page (either
 *     format is detected automatically); `--feed-url` records where it came from.
 *
 * Outputs (default `--out=data`, git-ignored):
 *   data/cidb-tenders-<date>.json      normalized tenders (+ documents) + summary
 *   data/cidb-tenders-<date>.csv       flat spreadsheet view
 *   data/ingest-summary.json           counts, breakdowns, warnings
 *   artifacts/cidb-source/…            raw feed/HTML snapshot (evidence, fixtures)
 *
 * To load the data into a real database instead, run the worker
 * (`DATABASE_URL=... npm run worker:once`) or trigger the deployed service
 * (`curl -X POST -H "X-API-Key: $ADMIN_API_KEY" $CIDB_API_URL/api/v1/admin/sync`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { isJsonFeedUrl } from '../src/cidb/factory.js';
import { fetchFeedPages } from '../src/cidb/jsonConnector.js';
import { feedDeclaredCount, parseFeedEntries, parseTendersJson, probeTendersJson } from '../src/cidb/jsonFeed.js';
import { ensureUniqueExternalIds, normalizeParsedTender } from '../src/cidb/normalizer.js';
import { parseCurrentTendersHtml } from '../src/cidb/parser.js';
import { fetchHtml, fetchJson } from '../src/cidb/scraper.js';
import { ParsedTender } from '../src/cidb/types.js';
import { config } from '../src/config.js';
import { NormalizedTender } from '../src/schemas/tender.js';

const DEFAULT_SOURCE_URL = 'https://www.cidb.org.za/tenders.json';
/** Public page the feed is rendered on — kept as the records' attribution URL. */
const DEFAULT_ATTRIBUTION_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
const DEFAULT_MAX_PAGES = 25;

interface Options {
  sourceUrl: string;
  /** Page size requested from the paginated feed (the site offers 10/25/50/100). */
  pageSize: number;
  /** Feed the data came from: provenance + base for resolving relative links. */
  feedUrl: string;
  attributionUrl: string;
  maxPages: number;
  outDir: string;
  rawDir: string | null;
  delayMs: number;
}

interface PageResult {
  pageNumber: number;
  url: string;
  rows: number;
  bytes: number;
}

interface ParsedRow {
  row: ParsedTender;
  pageUrl: string;
  pageNumber: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceUrl:
      process.env.CIDB_SOURCE_URL && !process.env.CIDB_SOURCE_URL.startsWith('file:')
        ? process.env.CIDB_SOURCE_URL
        : DEFAULT_SOURCE_URL,
    feedUrl: DEFAULT_SOURCE_URL,
    attributionUrl: DEFAULT_ATTRIBUTION_URL,
    pageSize: config.CIDB_FEED_PAGE_SIZE,
    maxPages: DEFAULT_MAX_PAGES,
    outDir: 'data',
    rawDir: 'artifacts/cidb-source',
    delayMs: config.REQUEST_DELAY_MS,
  };

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const value = equals === -1 ? '' : arg.slice(equals + 1);
    switch (flag) {
      case 'url':
        if (value) options.sourceUrl = value;
        break;
      case 'feed-url':
        if (value) options.feedUrl = value;
        break;
      case 'attribute-url':
        if (value) options.attributionUrl = value;
        break;
      case 'limit':
      case 'page-size':
        options.pageSize = Math.max(1, Number.parseInt(value, 10) || options.pageSize);
        break;
      case 'max-pages':
        options.maxPages = Math.max(1, Number.parseInt(value, 10) || DEFAULT_MAX_PAGES);
        break;
      case 'out':
        if (value) options.outDir = value;
        break;
      case 'raw':
        options.rawDir = value === 'none' ? null : value || options.rawDir;
        break;
      case 'delay':
        options.delayMs = Math.max(0, Number.parseInt(value, 10) || 0);
        break;
      default:
        break;
    }
  }
  return options;
}

const PAGINATION_SELECTORS = [
  'a.page-numbers',
  '.pagination a',
  '.nav-links a',
  '.elementor-pagination a',
  '.wp-pagenavi a',
  'nav[aria-label*="agination" i] a',
  'a[rel="next"]',
  'a.next.page-numbers',
].join(', ');

/** Pagination links on a WordPress/Elementor listing: same-origin, no documents. */
function extractPageLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(pageUrl).origin;
  const current = new URL(pageUrl).toString();
  const found: string[] = [];

  const push = (href: string | undefined): void => {
    if (!href || href.startsWith('#')) return;
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (absolute.origin !== origin) return;
    if (/\.(pdf|xlsx?|docx?|zip|csv|pptx?)(\?|$)/i.test(absolute.pathname)) return;
    const key = absolute.toString();
    if (key !== current && !found.includes(key)) found.push(key);
  };

  $(PAGINATION_SELECTORS).each((_, anchor) => push($(anchor).attr('href')));
  if (found.length === 0) {
    $('a[href]').each((_, anchor) => {
      const href = $(anchor).attr('href');
      if (href && /[?&]paged=\d+|\/page\/\d+\/?/i.test(href)) push(href);
    });
  }
  return found;
}

/** Ordering key so numbered pages are fetched ascending. */
function pageKey(url: string): number {
  const paged = /[?&]paged=(\d+)/i.exec(url);
  if (paged) return Number.parseInt(paged[1], 10);
  const slug = /\/page\/(\d+)\/?/i.exec(url);
  if (slug) return Number.parseInt(slug[1], 10);
  return Number.MAX_SAFE_INTEGER;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replay a captured source snapshot (`file:./path/tenders.json` or `.html`)
 * through the identical pipeline — no network, useful for tests and for
 * re-normalizing a feed captured elsewhere (e.g. by CI).
 */
async function ingestLocalFile(options: Options, pages: PageResult[], warnings: string[], rows: ParsedRow[]): Promise<void> {
  const path = options.sourceUrl.slice('file:'.length);
  const content = readFileSync(path, 'utf8');
  const isJson = /\.json$/i.test(path) || /^[{[]/.test(content.trimStart());
  // JSON snapshots resolve relative document links against the feed they came
  // from (not the local path), and keep that feed URL on the audit trail.
  const parsed = isJson
    ? parseTendersJson(JSON.parse(content) as unknown, options.feedUrl, options.attributionUrl)
    : parseCurrentTendersHtml(content, options.attributionUrl);
  pages.push({ pageNumber: 1, url: options.sourceUrl, rows: parsed.length, bytes: content.length });
  console.log(`  snapshot (${isJson ? 'JSON feed' : 'HTML listing'}): ${parsed.length} rows from ${path}`);
  for (const row of parsed) rows.push({ row, pageUrl: options.attributionUrl, pageNumber: 1 });
  if (parsed.length === 0) warnings.push(`snapshot ${path} contained no usable tender rows`);
  if (isJson) {
    // A snapshot holds only the page(s) that were captured: say so when the feed
    // declares more records than the file contains.
    const payload = JSON.parse(content) as unknown;
    const declared = feedDeclaredCount(payload);
    const held = probeTendersJson(payload).rowCount;
    if (declared !== null && held < declared) {
      warnings.push(`snapshot holds ${held} of the ${declared} records the feed declares (partial capture)`);
    }
  }
}

/**
 * Fetch the machine-readable feed. It is paginated server-side, so walk every
 * page (`?page=&limit=`) until the declared total is reached or a page adds
 * nothing new.
 */
async function ingestJsonFeed(options: Options, pages: PageResult[], warnings: string[], rows: ParsedRow[]): Promise<void> {
  const raws: string[] = [];
  const feed = await fetchFeedPages({
    sourceUrl: options.sourceUrl,
    pageSize: options.pageSize,
    maxPages: options.maxPages,
    delayMs: options.delayMs,
    fetch: async (url) => {
      const result = await fetchJson(url);
      raws.push(result.raw);
      return { json: result.json, raw: result.raw };
    },
    log: (message) => console.log(`  ${message}`),
  });

  const rawDir = options.rawDir;
  if (rawDir) {
    raws.forEach((raw, index) => {
      const name = index === 0 ? 'tenders.json' : `tenders-page-${index + 1}.json`;
      writeFileSync(join(rawDir, name), raw, 'utf8');
    });
  }

  const parsed = parseFeedEntries(feed.entries, options.sourceUrl, options.attributionUrl);
  for (const page of feed.pages) {
    pages.push({ pageNumber: page.page, url: page.url, rows: page.rows, bytes: page.bytes });
  }
  const bytes = feed.pages.reduce((total, page) => total + page.bytes, 0);
  console.log(
    `  feed: ${feed.entries.length} entries over ${feed.pages.length} page(s) ` +
      `(${(bytes / 1024).toFixed(0)} KB), ${parsed.length} usable` +
      ` [feed declares tender_count=${feed.declaredTotal ?? 'n/a'}]`,
  );
  for (const row of parsed) rows.push({ row, pageUrl: options.attributionUrl, pageNumber: 1 });
  warnings.push(...feed.warnings);
  if (feed.entries.length !== parsed.length) {
    warnings.push(`${feed.entries.length - parsed.length} feed entries had no usable content and were skipped`);
  }
  if (feed.declaredTotal !== null && feed.entries.length < feed.declaredTotal) {
    warnings.push(
      `source declares ${feed.declaredTotal} tenders but ${feed.entries.length} were returned — ` +
        `raise --limit/--max-pages or check the feed's paging parameters`,
    );
  }
  if (parsed.length === 0) {
    warnings.push(`feed at ${options.sourceUrl} contained no usable tender entries`);
  }
}

/** Follow a server-rendered HTML listing across its pagination links. */
async function crawlHtmlListing(
  options: Options,
  pages: PageResult[],
  warnings: string[],
  rows: ParsedRow[],
): Promise<void> {
  const visited = new Set<string>();
  let queue: string[] = [options.sourceUrl];

  while (queue.length > 0 && pages.length < options.maxPages) {
    const url = queue.shift() as string;
    if (visited.has(url)) continue;
    visited.add(url);
    if (options.delayMs > 0 && pages.length > 0) await sleep(options.delayMs);

    let html: string;
    try {
      html = (await fetchHtml(url)).html;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`page fetch failed: ${url} — ${message}`);
      console.error(`! fetch failed for ${url}: ${message}`);
      break; // never publish a silently partial dataset
    }

    const pageNumber = pages.length + 1;
    if (options.rawDir) writeFileSync(join(options.rawDir, `page-${pageNumber}.html`), html, 'utf8');

    let parsed: ParsedTender[];
    try {
      parsed = parseCurrentTendersHtml(html, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`page ${pageNumber} parse failed: ${url} — ${message}`);
      console.error(`! parse failed for ${url}: ${message}`);
      break;
    }

    pages.push({ pageNumber, url, rows: parsed.length, bytes: html.length });
    console.log(`  page ${pageNumber}: ${parsed.length} rows (${(html.length / 1024).toFixed(0)} KB) ${url}`);
    for (const row of parsed) rows.push({ row, pageUrl: url, pageNumber });

    for (const link of extractPageLinks(html, url).sort((a, b) => pageKey(a) - pageKey(b))) {
      if (!visited.has(link) && !queue.includes(link)) queue.push(link);
    }
  }

  if (pages.length === options.maxPages && queue.length > 0) {
    warnings.push(`stopped at --max-pages=${options.maxPages} with ${queue.length} page links still queued`);
  }
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(records: Array<Record<string, unknown>>): string {
  const headers = [
    'externalId',
    'bidNumber',
    'title',
    'organisation',
    'status',
    'sourceStatus',
    'province',
    'location',
    'tenderType',
    'cidbGrade',
    'cidbClass',
    'publishedDate',
    'closingDate',
    'briefingDate',
    'estimatedValue',
    'contactName',
    'contactEmail',
    'contactPhone',
    'documents',
    'documentUrls',
    'sourceUrl',
  ];
  const lines = [headers.join(',')];
  for (const record of records) {
    const contact = record.contact as { name?: string | null; email?: string | null; phone?: string | null } | undefined;
    const documents = (record.documents ?? []) as Array<{ url: string }>;
    const rawData = (record.rawData ?? {}) as { sourceStatusRaw?: string | null };
    lines.push(
      [
        record.externalId,
        record.bidNumber,
        record.title,
        record.organisation,
        record.status,
        rawData.sourceStatusRaw ?? '',
        record.province,
        record.location,
        record.tenderType,
        record.cidbGrade,
        record.cidbClass,
        record.publishedDate,
        record.closingDate,
        record.briefingDate,
        record.estimatedValue,
        contact?.name,
        contact?.email,
        contact?.phone,
        documents.length,
        documents.map((document) => document.url),
        record.sourceUrl,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const dateStamp = startedAt.toISOString().slice(0, 10);

  mkdirSync(options.outDir, { recursive: true });
  if (options.rawDir) mkdirSync(options.rawDir, { recursive: true });

  const kind = options.sourceUrl.startsWith('file:')
    ? 'local snapshot'
    : isJsonFeedUrl(options.sourceUrl)
      ? 'JSON feed'
      : 'HTML listing';
  // Pagination + politeness only apply to the HTML crawl.
  const crawlNotes =
    kind === 'HTML listing' ? ` (max ${options.maxPages} pages, ${options.delayMs}ms polite delay)` : '';
  console.log(`Ingesting ${kind}: ${options.sourceUrl}${crawlNotes}`);

  // ── 1. Fetch + parse ─────────────────────────────────────────────────────
  const pages: PageResult[] = [];
  const warnings: string[] = [];
  const parsedRows: ParsedRow[] = [];

  if (options.sourceUrl.startsWith('file:')) {
    await ingestLocalFile(options, pages, warnings, parsedRows);
  } else if (isJsonFeedUrl(options.sourceUrl)) {
    await ingestJsonFeed(options, pages, warnings, parsedRows);
  } else {
    await crawlHtmlListing(options, pages, warnings, parsedRows);
  }

  // ── 2. Normalize (identical to the sync pipeline) ────────────────────────
  const normalized: NormalizedTender[] = [];
  let normalizeFailures = 0;
  for (const { row, pageUrl, pageNumber } of parsedRows) {
    try {
      normalized.push(
        normalizeParsedTender(
          { ...row, sourceUrl: pageUrl, extra: { ...(row.extra ?? {}), pageNumber } },
          { closingSoonDays: config.CLOSING_SOON_DAYS, now: startedAt },
        ),
      );
    } catch (error) {
      normalizeFailures += 1;
      warnings.push(
        `record failed to normalize on page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const unique = ensureUniqueExternalIds(normalized);
  if (unique.length < normalized.length) {
    warnings.push(`${normalized.length - unique.length} duplicate externalIds were suffixed`);
  }

  // ── 3. Serialize ─────────────────────────────────────────────────────────
  const records = unique.map((tender) => ({
    externalId: tender.externalId,
    source: tender.source,
    bidNumber: tender.bidNumber,
    title: tender.title,
    description: tender.description,
    organisation: tender.organisation,
    tenderType: tender.tenderType,
    status: tender.status,
    province: tender.province,
    location: tender.location,
    municipality: tender.municipality,
    publishedDate: iso(tender.publishedDate),
    closingDate: iso(tender.closingDate),
    briefingDate: iso(tender.briefingDate),
    briefingRequired: tender.briefingRequired,
    briefingLocation: tender.briefingLocation,
    cidbGrade: tender.cidbGrade,
    cidbGradeRaw: tender.cidbGradeRaw,
    cidbClass: tender.cidbClass,
    cidbClassRaw: tender.cidbClassRaw,
    estimatedValue: tender.estimatedValue,
    contact: { name: tender.contactName, email: tender.contactEmail, phone: tender.contactPhone },
    documents: tender.documents.map((document) => ({
      name: document.name,
      documentType: document.documentType,
      url: document.url,
      fileName: document.fileName,
      mimeType: document.mimeType,
    })),
    sourceUrl: tender.sourceUrl,
    rawHash: tender.rawHash,
    rawData: tender.rawData,
  }));

  const countBy = (pick: (record: (typeof records)[number]) => string | null): Record<string, number> => {
    const buckets: Record<string, number> = {};
    for (const record of records) {
      const bucket = pick(record) ?? 'UNKNOWN';
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(buckets).sort((a, b) => b[1] - a[1]));
  };
  const closingDates = records
    .map((record) => record.closingDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  const publishedDates = records
    .map((record) => record.publishedDate)
    .filter((value): value is string => Boolean(value))
    .sort();

  const summary = {
    generatedAt: startedAt.toISOString(),
    source: options.sourceUrl,
    sourceKind: kind,
    pagesFetched: pages.length,
    pages,
    rowsParsed: parsedRows.length,
    tenders: records.length,
    documents: records.reduce((total, record) => total + record.documents.length, 0),
    normalizeFailures,
    byStatus: countBy((record) => record.status),
    byProvince: countBy((record) => record.province),
    byGrade: countBy((record) => record.cidbGrade),
    byTenderType: countBy((record) => record.tenderType),
    publishedDates: {
      earliest: publishedDates[0] ?? null,
      latest: publishedDates[publishedDates.length - 1] ?? null,
    },
    closingDates: {
      known: closingDates.length,
      unknown: records.length - closingDates.length,
      earliest: closingDates[0] ?? null,
      latest: closingDates[closingDates.length - 1] ?? null,
    },
    warnings,
  };

  const jsonPath = join(options.outDir, `cidb-tenders-${dateStamp}.json`);
  const csvPath = join(options.outDir, `cidb-tenders-${dateStamp}.csv`);
  const summaryPath = join(options.outDir, 'ingest-summary.json');
  writeFileSync(jsonPath, `${JSON.stringify({ summary, tenders: records }, null, 2)}\n`, 'utf8');
  writeFileSync(csvPath, toCsv(records as unknown as Array<Record<string, unknown>>), 'utf8');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`Source           : ${kind} (${pages.length} request(s))`);
  console.log(`Rows parsed      : ${parsedRows.length}`);
  console.log(`Tenders (unique) : ${records.length}`);
  console.log(`Documents        : ${summary.documents}`);
  console.log(`By status        : ${JSON.stringify(summary.byStatus)}`);
  console.log(`By province      : ${JSON.stringify(summary.byProvince)}`);
  console.log(`Published        : ${publishedDates[0] ?? 'n/a'} → ${publishedDates[publishedDates.length - 1] ?? 'n/a'}`);
  console.log(`Closing dates    : ${closingDates.length} known, ${records.length - closingDates.length} not published`);
  if (warnings.length > 0) console.log(`Warnings         : ${warnings.length} (details in ${summaryPath})`);
  console.log(`JSON             : ${jsonPath}`);
  console.log(`CSV              : ${csvPath}`);
  console.log(`Summary          : ${summaryPath}`);

  if (records.length === 0) {
    console.error('No tenders were ingested — refusing to report success.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
