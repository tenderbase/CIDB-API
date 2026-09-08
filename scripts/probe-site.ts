/**
 * Site-wide source probe (diagnostic, run from CI where cidb.org.za is reachable).
 *
 * Question it answers: the main feed serves 25 tenders while declaring
 * `tender_count=33` — do the missing records surface ANYWHERE else on the source
 * website? To find out this walks the site the way a person would:
 *
 *   1. robots.txt + sitemap(s) → tender-related URLs
 *   2. the tenders section pages (current / awarded / archived / cancelled and
 *      their pagination) → every allowed-host link mentioning "tender" or "bid"
 *   3. every `.json` endpoint referenced in page markup or inline JS (the current
 *      listing is rendered from one; a sibling listing may have its own)
 *   4. the CIDB public tender register on registers.cidb.org.za, which the site
 *      links to as its tender search
 *
 * Each URL is classified as a machine-readable feed, an HTML tender table, a
 * sitemap or neither. Bid numbers are collected three ways: from feed rows, from
 * HTML tables (through the production parser), and by scanning page text and link
 * URLs for bid-number patterns — so an award announcement or a cancellation
 * notice counts even when it is not a table row. Document links (PDF/XLS/…) are
 * recorded but NOT downloaded: their names carry bid numbers, their bytes do not
 * belong in a probe.
 *
 * Everything found is diffed against the bid numbers the main feed publishes, and
 * records that exist only elsewhere are named — split into "current" (matching a
 * financial-year suffix the feed itself uses, e.g. `…2627`) and historical.
 *
 * Usage:
 *   npx tsx scripts/probe-site.ts                          # → data/site-probe.json
 *   npx tsx scripts/probe-site.ts --max-urls=90 --delay=1000 --out=artifacts/site-probe.json
 *   npx tsx scripts/probe-site.ts --origin=http://127.0.0.1:8080   # offline smoke test
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';
import { extractFeedEntries, feedDeclaredCount, probeTendersJson } from '../src/cidb/jsonFeed.js';
import { parseCurrentTendersHtml, probeTenderTable } from '../src/cidb/parser.js';
import { fetchHtml } from '../src/cidb/scraper.js';
import { config } from '../src/config.js';

const DEFAULT_ORIGIN = 'https://www.cidb.org.za';
/** The site's own tender search lives on a second CIDB host — worth one look. */
const REGISTER_URL = 'https://registers.cidb.org.za/PublicTenders/TenderSearch';
/** Document extensions / upload paths: recorded, never downloaded. */
const DOCUMENT_EXTENSION = /\.(pdf|docx?|xlsx?|xlsm|pptx?|zip|rar|7z|csv|rtf)([?#]|$)/i;
/** Bid-number shapes seen on the site: "cidb 004 2627", "CIDB-003-2526", "RFB20020". */
const BID_PATTERNS = [/cidb[\s._-]*\d{3}[\s._-]*\d{4}/gi, /\brfb[\s._-]*\d{4,6}/gi];
/** Report-size guards. */
const MAX_BID_MATCHES_PER_URL = 200;
const MAX_DOCUMENT_LINKS = 500;
const MAX_EXTERNAL_LEADS = 100;

type Kind = 'json-feed' | 'html-table' | 'html' | 'sitemap' | 'robots' | 'binary' | 'error';

interface FetchedUrl {
  url: string;
  kind: Kind;
  status: number | null;
  bytes: number;
  foundOn: string | null;
  /** Rows in a feed or HTML tender table. */
  rows: number | null;
  declaredTotal: number | null;
  /** Bid numbers from structured rows (feed entries / parsed table rows). */
  bidNumbers: string[];
  /** Bid numbers mentioned anywhere in the page text or its link URLs. */
  bidMatches: string[];
  /** `.json` endpoints referenced by this page. */
  jsonEndpoints: string[];
  /** Document links found here (recorded, not fetched). */
  documentLinks: string[];
  /** Allowed-host links queued from here. */
  linksQueued: number;
  error: string | null;
}

interface SiteProbeReport {
  generatedAt: string;
  origin: string;
  mainFeed: string;
  registerUrl: string;
  userAgent: string;
  maxUrls: number;
  delayMs: number;
  visited: FetchedUrl[];
  skipped: { url: string; reason: string }[];
  documentLinks: string[];
  bidNumbers: {
    mainFeed: string[];
    elsewhere: string[];
    /** Seen somewhere on the site but NOT in the main feed — the interesting set. */
    onlyElsewhere: string[];
    /** …of those, the ones matching a financial-year suffix the feed itself uses. */
    onlyElsewhereCurrent: string[];
    onlyElsewhereFoundOn: Record<string, string[]>;
  };
  jsonEndpoints: { url: string; foundOn: string[]; rows: number | null; declaredTotal: number | null }[];
  externalLeads: string[];
  summary: {
    urlsVisited: number;
    feeds: number;
    htmlTables: number;
    nonEmptyTables: number;
    errors: number;
    documentsSkipped: number;
    distinctBidNumbers: number;
    fromFeedRows: number;
    fromPageText: number;
  };
  findings: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Display form: "cidb-004-2627" → "CIDB 004 2627". */
const normalizeBid = (value: string): string =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[._]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ');

/** Comparison key: alphanumerics only, so "CIDB-003-2526" == "cidb 003 2526". */
const bidKey = (value: string): string => normalizeBid(value).replace(/[^A-Z0-9]/g, '');

/** Trailing financial-year token, e.g. "CIDB 004 2627" → "2627". */
const yearSuffix = (value: string): string | null => {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/** Bid numbers mentioned in page text or link URLs (awards, cancellations, notices). */
function scanBidNumbers(body: string): string[] {
  const found = new Map<string, string>();
  for (const pattern of BID_PATTERNS) {
    for (const match of body.match(pattern) ?? []) {
      const key = bidKey(match);
      if (key && !found.has(key)) found.set(key, normalizeBid(match));
    }
  }
  return [...found.values()].sort().slice(0, MAX_BID_MATCHES_PER_URL);
}

function parseArgs(argv: string[]): { maxUrls: number; delayMs: number; outPath: string; origin: string } {
  let maxUrls = 90;
  let delayMs = config.REQUEST_DELAY_MS;
  let outPath = 'data/site-probe.json';
  let origin = DEFAULT_ORIGIN;
  for (const arg of argv) {
    const equals = arg.indexOf('=');
    if (!arg.startsWith('--') || equals === -1) continue;
    const flag = arg.slice(2, equals);
    const value = arg.slice(equals + 1);
    if (flag === 'max-urls') maxUrls = Math.max(1, Number.parseInt(value, 10) || maxUrls);
    if (flag === 'delay') delayMs = Math.max(0, Number.parseInt(value, 10) || 0);
    if (flag === 'out' && value) outPath = value;
    if (flag === 'origin' && value) origin = value.replace(/\/+$/, '');
  }
  return { maxUrls, delayMs, outPath, origin };
}

/** Where to start: the tenders section, its plausible siblings, the sitemaps, the register. */
function seedUrls(origin: string): string[] {
  return [
    `${origin}/tenders.json`,
    `${origin}/cidb-tenders/`,
    `${origin}/cidb-tenders/current-tenders/`,
    `${origin}/cidb-tenders/awarded-tenders/`,
    `${origin}/cidb-tenders/closed-tenders/`,
    `${origin}/cidb-tenders/archived-tenders/`,
    `${origin}/cidb-tenders/cancelled-tenders/`,
    `${origin}/tenders/`,
    `${origin}/tender-bulletin/`,
    `${origin}/tender-awards/`,
    `${origin}/robots.txt`,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    REGISTER_URL,
  ];
}

/** Hosts this probe may fetch: the origin (either spelling) plus the CIDB register. */
function allowedHosts(origin: string): Set<string> {
  const hosts = new Set<string>(['www.cidb.org.za', 'cidb.org.za', 'registers.cidb.org.za']);
  try {
    hosts.add(new URL(origin).hostname.toLowerCase());
  } catch {
    // unusable --origin: the walk simply finds nothing
  }
  return hosts;
}

const isAllowedHost = (url: URL, hosts: Set<string>): boolean => hosts.has(url.hostname.toLowerCase());

function isDocumentUrl(url: URL): boolean {
  return DOCUMENT_EXTENSION.test(url.pathname) || /\/wp-content\/uploads\//i.test(url.pathname);
}

/** Worth following: mentions tenders/bids, is a feed, or is a sitemap. */
function isInteresting(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return /tender|bid/.test(path) || path.endsWith('.json') || /sitemap/.test(path);
}

function canonical(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString();
}

interface References {
  links: string[];
  jsonEndpoints: string[];
  documents: string[];
  external: string[];
}

/** Links, feeds, documents and off-site leads referenced by a page. */
function extractReferences(body: string, baseUrl: string, hosts: Set<string>): References {
  const links = new Set<string>();
  const jsonEndpoints = new Set<string>();
  const documents = new Set<string>();
  const external = new Set<string>();

  const consider = (href: string): void => {
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return; // relative junk / malformed href
    }
    if (!/^https?:$/.test(resolved.protocol)) return;
    const key = canonical(resolved);
    if (!isAllowedHost(resolved, hosts)) {
      if (/tender|bid/i.test(key) && external.size < MAX_EXTERNAL_LEADS) external.add(key);
      return;
    }
    if (isDocumentUrl(resolved)) {
      if (documents.size < MAX_DOCUMENT_LINKS) documents.add(key);
      return;
    }
    if (resolved.pathname.toLowerCase().endsWith('.json')) jsonEndpoints.add(key);
    if (isInteresting(resolved)) links.add(key);
  };

  const $ = cheerio.load(body);
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (href) consider(href);
  });

  // Endpoints built in inline JS — which is how tenders.json was found originally.
  for (const match of body.match(/https?:\\?\/\\?\/[^"'\\\s<>]+?\.json[^"'\\\s<>]*/gi) ?? []) {
    consider(match.replace(/\\\//g, '/').replace(/[?&](r|_)=[\d.]+/gi, ''));
  }
  for (const match of body.match(/["'(]\s*\/[^"')\s<>]+\.json/gi) ?? []) {
    consider(match.replace(/^["'(]\s*/, ''));
  }
  // Sitemap <loc> entries (also covers sitemap indexes).
  for (const match of body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) ?? []) {
    consider(match.replace(/<\/?loc>/gi, '').trim());
  }

  return { links: [...links], jsonEndpoints: [...jsonEndpoints], documents: [...documents], external: [...external] };
}

interface Classified {
  kind: Kind;
  status: number;
  bytes: number;
  rows: number | null;
  declaredTotal: number | null;
  bidNumbers: string[];
  bidMatches: string[];
  jsonEndpoints: string[];
  documentLinks: string[];
}

function classify(url: string, body: string, status: number): Classified {
  const bytes = Buffer.byteLength(body, 'utf8');
  const lowered = url.toLowerCase();
  const trimmed = body.trimStart();
  const base = { status, bytes, jsonEndpoints: [] as string[], documentLinks: [] as string[] };

  // Machine-readable feed?
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || lowered.endsWith('.json')) {
    try {
      const json = JSON.parse(body) as unknown;
      const probe = probeTendersJson(json);
      const entries = extractFeedEntries(json);
      return {
        ...base,
        kind: 'json-feed',
        rows: probe.rowCount,
        declaredTotal: feedDeclaredCount(json),
        bidNumbers: entries.map((entry) => normalizeBid(String(entry.bid_number ?? ''))).filter((bid) => bid !== ''),
        bidMatches: [],
      };
    } catch {
      // not JSON after all — fall through
    }
  }

  if (lowered.endsWith('robots.txt') || /user-agent:/i.test(body.slice(0, 400))) {
    return { ...base, kind: 'robots', rows: null, declaredTotal: null, bidNumbers: [], bidMatches: scanBidNumbers(body) };
  }
  if (/<\s*(urlset|sitemapindex)/i.test(body)) {
    return { ...base, kind: 'sitemap', rows: null, declaredTotal: null, bidNumbers: [], bidMatches: scanBidNumbers(body) };
  }

  // HTML tender table? Run it through the production parser when there is one.
  const probe = probeTenderTable(body);
  if (probe.found) {
    let bidNumbers: string[] = [];
    try {
      bidNumbers = parseCurrentTendersHtml(body, url)
        .map((tender) => normalizeBid(tender.bidNumber ?? ''))
        .filter((bid) => bid !== '');
    } catch {
      bidNumbers = [];
    }
    return {
      ...base,
      kind: 'html-table',
      rows: probe.rowCount,
      declaredTotal: null,
      bidNumbers,
      bidMatches: scanBidNumbers(body),
    };
  }

  const kind: Kind = /^<\s*(!doctype\s+html|html)/i.test(trimmed) ? 'html' : 'binary';
  return {
    ...base,
    kind,
    rows: null,
    declaredTotal: null,
    bidNumbers: [],
    // Text scan still runs on ordinary pages: award/cancellation notices are posts,
    // not tables, and their titles and links carry bid numbers.
    bidMatches: kind === 'html' ? scanBidNumbers(body) : [],
  };
}

async function main(): Promise<void> {
  const { maxUrls, delayMs, outPath, origin } = parseArgs(process.argv.slice(2));
  const mainFeed = `${origin}/tenders.json`;
  const hosts = allowedHosts(origin);
  console.log(`Probing ${origin} for other tender sources (max ${maxUrls} URLs, ${delayMs}ms apart)\n`);

  const queue: { url: string; foundOn: string | null }[] = seedUrls(origin).map((url) => ({ url, foundOn: null }));
  const seen = new Set<string>();
  const visited: FetchedUrl[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const documentLinks = new Set<string>();
  const endpointFoundOn = new Map<string, Set<string>>();
  const externalLeads = new Set<string>();
  let capReached = false;

  while (queue.length > 0) {
    if (visited.length >= maxUrls) {
      capReached = true;
      skipped.push(...queue.map((item) => ({ url: item.url, reason: `max-urls=${maxUrls} reached` })));
      break;
    }
    const { url, foundOn } = queue.shift() as { url: string; foundOn: string | null };

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      skipped.push({ url, reason: 'not a URL' });
      continue;
    }
    const key = canonical(parsedUrl);
    if (seen.has(key)) continue;
    seen.add(key);

    // Never download documents — but their names are evidence, so keep the link.
    if (isDocumentUrl(parsedUrl)) {
      if (documentLinks.size < MAX_DOCUMENT_LINKS) documentLinks.add(key);
      skipped.push({ url, reason: 'document link (recorded, not downloaded)' });
      console.log(`${String(visited.length + 1).padStart(3)}. document    ${url.slice(0, 110)}`);
      continue;
    }

    let record: FetchedUrl;
    try {
      // minBytes: 0 — for a probe, a tiny body (robots.txt, an empty feed) is an
      // answer to record, not a request failure.
      const { html, status, finalUrl } = await fetchHtml(url, { maxRetries: 1, minBytes: 0 });
      const effectiveUrl = finalUrl || url;
      const classified = classify(effectiveUrl, html, status);
      const references =
        classified.kind === 'binary' ? { links: [], jsonEndpoints: [], documents: [], external: [] } : extractReferences(html, effectiveUrl, hosts);

      let queued = 0;
      for (const candidate of [...references.links, ...references.jsonEndpoints]) {
        const candidateKey = canonical(new URL(candidate));
        if (seen.has(candidateKey)) continue;
        const candidateUrl = new URL(candidate);
        if (!isAllowedHost(candidateUrl, hosts)) continue;
        if (isDocumentUrl(candidateUrl)) {
          if (documentLinks.size < MAX_DOCUMENT_LINKS) documentLinks.add(candidateKey);
          continue;
        }
        if (!isInteresting(candidateUrl)) continue;
        queue.push({ url: candidate, foundOn: effectiveUrl });
        queued += 1;
      }
      for (const document of references.documents) {
        if (documentLinks.size < MAX_DOCUMENT_LINKS) documentLinks.add(document);
      }
      for (const lead of references.external) externalLeads.add(lead);
      for (const endpoint of references.jsonEndpoints) {
        if (!endpointFoundOn.has(endpoint)) endpointFoundOn.set(endpoint, new Set());
        endpointFoundOn.get(endpoint)?.add(effectiveUrl);
      }

      record = { url, foundOn, linksQueued: queued, error: null, ...classified };
      console.log(
        `${String(visited.length + 1).padStart(3)}. ${record.kind.padEnd(11)} HTTP ${String(record.status).padEnd(4)} ` +
          `${String(record.bytes).padStart(7)}B rows=${String(record.rows ?? '-').padStart(3)} ` +
          `bids=${String(record.bidNumbers.length).padStart(3)} text=${String(record.bidMatches.length).padStart(3)} ` +
          `docs=${String(record.documentLinks.length).padStart(2)} +${queued} links  ${url.slice(0, 88)}`,
      );
    } catch (error) {
      record = {
        url,
        kind: 'error',
        status: null,
        bytes: 0,
        foundOn,
        rows: null,
        declaredTotal: null,
        bidNumbers: [],
        bidMatches: [],
        jsonEndpoints: [],
        documentLinks: [],
        linksQueued: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      console.log(`${String(visited.length + 1).padStart(3)}. error        ${url.slice(0, 88)} — ${(record.error ?? '').slice(0, 100)}`);
    }
    visited.push(record);
    if (queue.length > 0 && delayMs > 0) await sleep(delayMs);
  }

  // ── Bid-number diff: main feed vs everywhere else ──────────────────────────
  const mainRecord = visited.find((record) => canonical(new URL(record.url)) === canonical(new URL(mainFeed)) && record.kind === 'json-feed');
  const feedKeys = new Set((mainRecord?.bidNumbers ?? []).map(bidKey));
  const elsewhere = new Map<string, { display: string; urls: Set<string> }>();
  for (const record of visited) {
    if (mainRecord && record.url === mainRecord.url) continue;
    for (const bid of [...record.bidNumbers, ...record.bidMatches]) {
      const key = bidKey(bid);
      if (!key) continue;
      if (!elsewhere.has(key)) elsewhere.set(key, { display: normalizeBid(bid), urls: new Set() });
      elsewhere.get(key)?.urls.add(record.url);
    }
  }
  const feedYears = new Set(
    (mainRecord?.bidNumbers ?? []).map((bid) => yearSuffix(bid)).filter((year): year is string => year !== null),
  );
  const onlyElsewhere = [...elsewhere.entries()]
    .filter(([key]) => !feedKeys.has(key))
    .map(([, value]) => value.display)
    .sort();
  const onlyElsewhereCurrent = [...elsewhere.entries()]
    .filter(([key]) => !feedKeys.has(key))
    .filter(([, value]) => {
      const year = yearSuffix(value.display);
      return year !== null && feedYears.has(year);
    })
    .map(([, value]) => value.display)
    .sort();
  const onlyElsewhereFoundOn: Record<string, string[]> = {};
  for (const [key, value] of elsewhere) {
    if (feedKeys.has(key)) continue;
    onlyElsewhereFoundOn[value.display] = [...value.urls];
  }
  const allKeys = new Set([...feedKeys, ...elsewhere.keys()]);

  const feeds = visited.filter((record) => record.kind === 'json-feed');
  const tables = visited.filter((record) => record.kind === 'html-table');
  const nonEmptyTables = tables.filter((table) => (table.rows ?? 0) > 0);
  const errors = visited.filter((record) => record.kind === 'error');
  const registerRecord = visited.find((record) => record.url.startsWith('https://registers.cidb.org.za/'));
  const textBidCount = new Set(visited.flatMap((record) => record.bidMatches.map(bidKey))).size;

  const findings: string[] = [];
  findings.push(
    mainRecord
      ? `main feed ${mainFeed}: ${mainRecord.rows} rows, tender_count declares ${mainRecord.declaredTotal ?? 'n/a'}, ${feedKeys.size} distinct bid numbers (financial-year suffixes: ${[...feedYears].sort().join(', ') || 'n/a'})`
      : `main feed ${mainFeed} could not be read`,
  );
  findings.push(
    feeds.length > 1
      ? `${feeds.length} machine-readable feeds found: ${feeds.map((feed) => `${feed.url} (${feed.rows} rows)`).join(', ')}`
      : feeds.length === 1
        ? 'no second machine-readable feed exists on the site (tenders.json is the only one)'
        : 'no machine-readable feed found at all',
  );
  findings.push(
    tables.length === 0
      ? 'no server-rendered tender table found anywhere on the site'
      : `${tables.length} page(s) expose an HTML tender table: ${tables.map((table) => `${table.url} (${table.rows} rows)`).join(', ')}`,
  );
  findings.push(
    nonEmptyTables.length === 0
      ? 'every HTML tender table found is EMPTY in the served markup (browser-rendered), so HTML scraping cannot add records'
      : `${nonEmptyTables.length} table(s) have rows in the served markup — those records are reachable without the feed`,
  );
  findings.push(
    onlyElsewhere.length === 0
      ? `no bid number appears anywhere else on the site that is missing from the main feed (union across ${visited.length} URLs = ${allKeys.size})`
      : `${onlyElsewhere.length} bid number(s) appear on the site but NOT in the main feed (${textBidCount} distinct numbers seen in page text overall)`,
  );
  if (onlyElsewhereCurrent.length > 0) {
    findings.push(
      `${onlyElsewhereCurrent.length} of those look CURRENT (same financial-year suffix as feed records) — candidates for the missing tenders: ${onlyElsewhereCurrent.slice(0, 20).join(', ')}`,
    );
  } else if (onlyElsewhere.length > 0) {
    findings.push(
      `none of them match a financial-year suffix the feed uses (${[...feedYears].sort().join(', ') || 'n/a'}) — they are historical notices (awards/cancellations), not missing current tenders`,
    );
  }
  if (registerRecord) {
    findings.push(
      registerRecord.kind === 'error'
        ? `the linked public tender register (${registerRecord.url}) could not be fetched: ${(registerRecord.error ?? '').slice(0, 120)}`
        : `the linked public tender register ${registerRecord.url} responded ${registerRecord.kind} (${registerRecord.bytes} bytes` +
          `${registerRecord.jsonEndpoints.length > 0 ? `, references ${registerRecord.jsonEndpoints.length} JSON endpoint(s): ${registerRecord.jsonEndpoints.slice(0, 5).join(', ')}` : ', references no JSON endpoint'}` +
          `${registerRecord.bidMatches.length > 0 ? `, mentions ${registerRecord.bidMatches.length} bid number(s)` : ''})`,
    );
  }
  if (externalLeads.size > 0) {
    findings.push(
      `${externalLeads.size} off-site tender lead(s) linked from the site (not fetched): ${[...externalLeads].slice(0, 10).join(', ')}`,
    );
  }
  findings.push(`${documentLinks.size} document link(s) recorded but not downloaded (PDF/XLS notices, bid documents)`);
  if (errors.length > 0) {
    const notFound = errors.filter((record) => /404/.test(record.error ?? ''));
    findings.push(
      `${errors.length} URL(s) failed (${notFound.length} of them 404): ${errors.slice(0, 8).map((record) => record.url).join(', ')}`,
    );
  }
  if (capReached) findings.push(`stopped at --max-urls=${maxUrls} with ${queue.length} URL(s) still queued`);

  const report: SiteProbeReport = {
    generatedAt: new Date().toISOString(),
    origin,
    mainFeed,
    registerUrl: REGISTER_URL,
    userAgent: config.CIDB_USER_AGENT,
    maxUrls,
    delayMs,
    visited,
    skipped: skipped.slice(0, 400),
    documentLinks: [...documentLinks],
    bidNumbers: {
      mainFeed: (mainRecord?.bidNumbers ?? []).map(normalizeBid).sort(),
      elsewhere: [...elsewhere.values()].map((value) => value.display).sort(),
      onlyElsewhere,
      onlyElsewhereCurrent,
      onlyElsewhereFoundOn,
    },
    jsonEndpoints: [...endpointFoundOn.entries()].map(([url, foundOn]) => {
      const record = visited.find((item) => canonical(new URL(item.url)) === url);
      return { url, foundOn: [...foundOn], rows: record?.rows ?? null, declaredTotal: record?.declaredTotal ?? null };
    }),
    externalLeads: [...externalLeads],
    summary: {
      urlsVisited: visited.length,
      feeds: feeds.length,
      htmlTables: tables.length,
      nonEmptyTables: nonEmptyTables.length,
      errors: errors.length,
      documentsSkipped: documentLinks.size,
      distinctBidNumbers: allKeys.size,
      fromFeedRows: feedKeys.size,
      fromPageText: textBidCount,
    },
    findings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nSummary: ${JSON.stringify(report.summary)}`);
  console.log('\nFindings:');
  for (const finding of findings) console.log(`  • ${finding}`);
  if (onlyElsewhereCurrent.length > 0) {
    console.log('\nCurrent-looking bid numbers missing from the feed:');
    for (const bid of onlyElsewhereCurrent.slice(0, 25)) {
      console.log(`  ${bid} → ${(onlyElsewhereFoundOn[bid] ?? []).slice(0, 3).join(', ')}`);
    }
  }
  console.log(`\nReport written to ${outPath}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
