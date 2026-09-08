/**
 * Site-wide source probe (diagnostic, run from CI where cidb.org.za is reachable).
 *
 * Question it answers: the main feed serves 25 tenders while declaring
 * `tender_count=33` — do the missing records surface ANYWHERE else on the source
 * website? To find out this walks the site the way a person would:
 *
 *   1. robots.txt + sitemap(s) → tender-related URLs
 *   2. the tenders section pages → every same-host link mentioning "tender"
 *   3. every `.json` endpoint referenced in page HTML/JS (the current listing is
 *      rendered from one; sibling listings may have their own)
 *
 * and for each URL classifies what it holds — a machine-readable feed, an
 * HTML tender table, or neither — then diffs the bid numbers found against the
 * ones the main feed publishes. Anything that appears only elsewhere is a
 * candidate for the missing records.
 *
 * Usage:
 *   npx tsx scripts/probe-site.ts                          # → data/site-probe.json
 *   npx tsx scripts/probe-site.ts --max-urls=80 --delay=1000 --out=artifacts/site-probe.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';
import { extractFeedEntries, feedDeclaredCount, probeTendersJson } from '../src/cidb/jsonFeed.js';
import { parseCurrentTendersHtml, probeTenderTable } from '../src/cidb/parser.js';
import { fetchHtml } from '../src/cidb/scraper.js';
import { config } from '../src/config.js';

const ORIGIN = 'https://www.cidb.org.za';
const MAIN_FEED = `${ORIGIN}/tenders.json`;

/** Where to start looking. Deliberately includes the plausible sibling slugs. */
const SEED_URLS = [
  `${ORIGIN}/robots.txt`,
  `${ORIGIN}/sitemap.xml`,
  `${ORIGIN}/sitemap_index.xml`,
  `${ORIGIN}/wp-sitemap.xml`,
  `${ORIGIN}/cidb-tenders/`,
  `${ORIGIN}/cidb-tenders/current-tenders/`,
  `${ORIGIN}/cidb-tenders/awarded-tenders/`,
  `${ORIGIN}/cidb-tenders/closed-tenders/`,
  `${ORIGIN}/cidb-tenders/archived-tenders/`,
  `${ORIGIN}/cidb-tenders/cancelled-tenders/`,
  `${ORIGIN}/tenders/`,
  `${ORIGIN}/tender-bulletin/`,
  `${ORIGIN}/tender-awards/`,
  MAIN_FEED,
];

type Kind = 'json-feed' | 'html-table' | 'html' | 'sitemap' | 'robots' | 'binary' | 'error';

interface FetchedUrl {
  url: string;
  kind: Kind;
  status: number | null;
  bytes: number;
  foundOn: string | null;
  /** Feed/table rows discovered here. */
  rows: number | null;
  declaredTotal: number | null;
  bidNumbers: string[];
  /** `.json` endpoints referenced by this page (or discovered in a sitemap). */
  jsonEndpoints: string[];
  /** Same-host links worth following, discovered here. */
  linksQueued: number;
  error: string | null;
}

interface SiteProbeReport {
  generatedAt: string;
  origin: string;
  mainFeed: string;
  userAgent: string;
  maxUrls: number;
  delayMs: number;
  visited: FetchedUrl[];
  skipped: { url: string; reason: string }[];
  bidNumbers: {
    mainFeed: string[];
    elsewhere: string[];
    /** Present somewhere on the site but NOT in the main feed — the interesting set. */
    onlyElsewhere: string[];
  };
  jsonEndpoints: { url: string; foundOn: string[]; rows: number | null; declaredTotal: number | null }[];
  externalLeads: string[];
  summary: {
    urlsVisited: number;
    feeds: number;
    htmlTables: number;
    nonEmptyTables: number;
    errors: number;
    distinctBidNumbers: number;
  };
  findings: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bid numbers compared case/space-insensitively, displayed normalized. */
const normalizeBid = (value: string): string => value.replace(/\s+/g, ' ').trim().toUpperCase();

function parseArgs(argv: string[]): { maxUrls: number; delayMs: number; outPath: string } {
  let maxUrls = 60;
  let delayMs = config.REQUEST_DELAY_MS;
  let outPath = 'data/site-probe.json';
  for (const arg of argv) {
    const equals = arg.indexOf('=');
    if (!arg.startsWith('--') || equals === -1) continue;
    const flag = arg.slice(2, equals);
    const value = arg.slice(equals + 1);
    if (flag === 'max-urls') maxUrls = Math.max(1, Number.parseInt(value, 10) || maxUrls);
    if (flag === 'delay') delayMs = Math.max(0, Number.parseInt(value, 10) || 0);
    if (flag === 'out' && value) outPath = value;
  }
  return { maxUrls, delayMs, outPath };
}

function isSameHost(url: URL): boolean {
  return url.hostname === 'www.cidb.org.za' || url.hostname === 'cidb.org.za';
}

/** Worth following: mentions tenders, is a feed, or is a sitemap. */
function isInteresting(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return /tender/.test(path) || path.endsWith('.json') || /sitemap/.test(path) || /bid/.test(path);
}

function canonical(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString();
}

/** Links + `.json` endpoints referenced anywhere in a page's markup or inline JS. */
function extractReferences(body: string, baseUrl: string): { links: string[]; jsonEndpoints: string[]; external: string[] } {
  const links = new Set<string>();
  const jsonEndpoints = new Set<string>();
  const external = new Set<string>();

  const $ = cheerio.load(body);
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (!/^https?:$/.test(resolved.protocol)) return;
      if (isSameHost(resolved)) {
        if (isInteresting(resolved)) links.add(canonical(resolved));
        if (resolved.pathname.toLowerCase().endsWith('.json')) jsonEndpoints.add(canonical(resolved));
      } else if (/tender/i.test(resolved.toString())) {
        external.add(canonical(resolved));
      }
    } catch {
      // relative junk / malformed href — ignore
    }
  });

  // Endpoints built in inline JS (how tenders.json was found in the first place).
  const rawJson = body.match(/https?:\\?\/\\?\/[^"'\\\s]+?\.json[^"'\\\s]*/gi) ?? [];
  for (const match of rawJson) {
    const cleaned = match.replace(/\\\//g, '/').replace(/[?&](r|_)=\d+$/i, '');
    try {
      const resolved = new URL(cleaned, baseUrl);
      if (isSameHost(resolved)) jsonEndpoints.add(canonical(resolved));
    } catch {
      // ignore
    }
  }
  const relativeJson = body.match(/["'(]\s*\/[^"')\s]+\.json/gi) ?? [];
  for (const match of relativeJson) {
    const path = match.replace(/^["'(]\s*/, '');
    try {
      jsonEndpoints.add(canonical(new URL(path, baseUrl)));
    } catch {
      // ignore
    }
  }

  return { links: [...links], jsonEndpoints: [...jsonEndpoints], external: [...external] };
}

/** <loc> entries from sitemap XML (also handles sitemap indexes). */
function extractSitemapLocations(body: string, baseUrl: string): string[] {
  const locations = new Set<string>();
  const matches = body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) ?? [];
  for (const match of matches) {
    const value = match.replace(/<\/?loc>/gi, '').trim();
    try {
      const resolved = new URL(value, baseUrl);
      if (isSameHost(resolved)) locations.add(canonical(resolved));
    } catch {
      // ignore
    }
  }
  return [...locations];
}

function classify(url: string, body: string, status: number): Omit<FetchedUrl, 'url' | 'foundOn' | 'linksQueued' | 'error'> {
  const bytes = Buffer.byteLength(body, 'utf8');
  const lowered = url.toLowerCase();
  const trimmed = body.trimStart();

  // JSON feed?
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || lowered.endsWith('.json')) {
    try {
      const json = JSON.parse(body) as unknown;
      const probe = probeTendersJson(json);
      const entries = extractFeedEntries(json);
      return {
        kind: 'json-feed',
        status,
        bytes,
        rows: probe.rowCount,
        declaredTotal: feedDeclaredCount(json),
        bidNumbers: entries
          .map((entry) => normalizeBid(String(entry.bid_number ?? '')))
          .filter((bid) => bid !== ''),
        jsonEndpoints: [],
      };
    } catch {
      // not JSON after all — fall through
    }
  }

  // robots.txt / sitemap XML
  if (lowered.endsWith('robots.txt') || /user-agent:/i.test(body.slice(0, 400))) {
    return { kind: 'robots', status, bytes, rows: null, declaredTotal: null, bidNumbers: [], jsonEndpoints: [] };
  }
  if (/<\s*(urlset|sitemapindex)/i.test(body)) {
    return { kind: 'sitemap', status, bytes, rows: null, declaredTotal: null, bidNumbers: [], jsonEndpoints: [] };
  }

  // HTML tender table?
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
      kind: 'html-table',
      status,
      bytes,
      rows: probe.rowCount,
      declaredTotal: null,
      bidNumbers,
      jsonEndpoints: [],
    };
  }

  if (/^<\s*(!doctype\s+html|html)/i.test(trimmed)) {
    return { kind: 'html', status, bytes, rows: null, declaredTotal: null, bidNumbers: [], jsonEndpoints: [] };
  }
  return { kind: 'binary', status, bytes, rows: null, declaredTotal: null, bidNumbers: [], jsonEndpoints: [] };
}

async function main(): Promise<void> {
  const { maxUrls, delayMs, outPath } = parseArgs(process.argv.slice(2));
  console.log(`Probing ${ORIGIN} for other tender sources (max ${maxUrls} URLs, ${delayMs}ms apart)\n`);

  const queue: { url: string; foundOn: string | null }[] = SEED_URLS.map((url) => ({ url, foundOn: null }));
  const seen = new Set<string>();
  const visited: FetchedUrl[] = [];
  const skipped: { url: string; reason: string }[] = [];
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
    const key = canonical(new URL(url));
    if (seen.has(key)) continue;
    seen.add(key);

    let record: FetchedUrl;
    try {
      const { html, status, finalUrl } = await fetchHtml(url, { maxRetries: 1 });
      const classified = classify(finalUrl || url, html, status);
      const references =
        classified.kind === 'html' || classified.kind === 'html-table' || classified.kind === 'robots'
          ? extractReferences(html, finalUrl || url)
          : { links: [], jsonEndpoints: [], external: [] };
      const sitemapLocations =
        classified.kind === 'sitemap' || classified.kind === 'robots' ? extractSitemapLocations(html, finalUrl || url) : [];

      // Follow sitemap <loc> entries only when they look tender-related, plus any
      // nested sitemap (so a sitemap index still leads somewhere useful).
      const queued: string[] = [];
      for (const candidate of [...references.links, ...sitemapLocations, ...references.jsonEndpoints, ...classified.jsonEndpoints]) {
        const candidateKey = canonical(new URL(candidate));
        if (seen.has(candidateKey)) continue;
        const parsed = new URL(candidate);
        if (!isSameHost(parsed)) continue;
        if (/sitemap/.test(parsed.pathname.toLowerCase()) || isInteresting(parsed)) {
          queued.push(candidate);
          queue.push({ url: candidate, foundOn: finalUrl || url });
        }
      }
      for (const endpoint of [...references.jsonEndpoints, ...classified.jsonEndpoints]) {
        const endpointKey = canonical(new URL(endpoint));
        if (!endpointFoundOn.has(endpointKey)) endpointFoundOn.set(endpointKey, new Set());
        endpointFoundOn.get(endpointKey)?.add(finalUrl || url);
      }
      for (const lead of references.external) externalLeads.add(lead);

      record = { url, foundOn, linksQueued: queued.length, error: null, ...classified };
      // A feed's own rows are its bid numbers; report them where found.
      console.log(
        `${String(visited.length + 1).padStart(3)}. ${record.kind.padEnd(11)} HTTP ${String(record.status).padEnd(4)} ` +
          `${String(record.bytes).padStart(7)}B rows=${String(record.rows ?? '-').padStart(3)} ` +
          `bids=${String(record.bidNumbers.length).padStart(3)} +${queued.length} links  ${url}`,
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
        jsonEndpoints: [],
        linksQueued: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      console.log(`${String(visited.length + 1).padStart(3)}. error        ${url} — ${(record.error ?? '').slice(0, 110)}`);
    }
    visited.push(record);
    if (queue.length > 0 && delayMs > 0) await sleep(delayMs);
  }

  // ── Bid-number diff: main feed vs everywhere else ──────────────────────────
  const mainRecord = visited.find((record) => record.url === MAIN_FEED && record.kind === 'json-feed');
  const mainBids = new Set(mainRecord?.bidNumbers ?? []);
  const elsewhere = new Map<string, string[]>();
  for (const record of visited) {
    if (record.url === MAIN_FEED) continue;
    for (const bid of record.bidNumbers) {
      if (!elsewhere.has(bid)) elsewhere.set(bid, []);
      elsewhere.get(bid)?.push(record.url);
    }
  }
  const onlyElsewhere = [...elsewhere.keys()].filter((bid) => !mainBids.has(bid)).sort();
  const allBids = new Set([...mainBids, ...elsewhere.keys()]);

  const feeds = visited.filter((record) => record.kind === 'json-feed');
  const tables = visited.filter((record) => record.kind === 'html-table');
  const errors = visited.filter((record) => record.kind === 'error');

  const findings: string[] = [];
  findings.push(
    mainRecord
      ? `main feed ${MAIN_FEED}: ${mainRecord.rows} rows, tender_count declares ${mainRecord.declaredTotal ?? 'n/a'}, ${mainBids.size} distinct bid numbers`
      : `main feed ${MAIN_FEED} could not be read`,
  );
  findings.push(
    feeds.length > 1
      ? `${feeds.length} machine-readable feeds found: ${feeds.map((f) => `${f.url} (${f.rows} rows)`).join(', ')}`
      : feeds.length === 1
        ? 'no additional machine-readable feed exists on the site (only tenders.json)'
        : 'no machine-readable feed found at all',
  );
  findings.push(
    tables.length === 0
      ? 'no server-rendered tender table found anywhere on the site'
      : `${tables.length} page(s) expose an HTML tender table: ` +
        tables.map((t) => `${t.url} (${t.rows} rows)`).join(', '),
  );
  const nonEmptyTables = tables.filter((table) => (table.rows ?? 0) > 0);
  findings.push(
    nonEmptyTables.length === 0
      ? 'every HTML tender table found is EMPTY in the served markup (browser-rendered), so HTML scraping cannot add records'
      : `${nonEmptyTables.length} table(s) have rows in the served markup — those records are reachable without the feed`,
  );
  findings.push(
    onlyElsewhere.length === 0
      ? `no bid number found anywhere else on the site that is missing from the main feed (union = ${allBids.size})`
      : `${onlyElsewhere.length} bid number(s) appear on the site but NOT in the main feed: ${onlyElsewhere.join(', ')}`,
  );
  if (externalLeads.size > 0) {
    findings.push(
      `${externalLeads.size} off-site tender lead(s) linked from the site (not fetched): ${[...externalLeads].slice(0, 10).join(', ')}`,
    );
  }
  if (errors.length > 0) {
    const notFound = errors.filter((record) => /404/.test(record.error ?? ''));
    findings.push(
      `${errors.length} URL(s) failed (${notFound.length} of them 404) — e.g. ` +
        errors.slice(0, 6).map((record) => record.url).join(', '),
    );
  }
  if (capReached) findings.push(`stopped at --max-urls=${maxUrls} with ${queue.length} URL(s) still queued`);

  const report: SiteProbeReport = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    mainFeed: MAIN_FEED,
    userAgent: config.CIDB_USER_AGENT,
    maxUrls,
    delayMs,
    visited,
    skipped: skipped.slice(0, 200),
    bidNumbers: {
      mainFeed: [...mainBids].sort(),
      elsewhere: [...elsewhere.keys()].sort(),
      onlyElsewhere,
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
      distinctBidNumbers: allBids.size,
    },
    findings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nSummary: ${JSON.stringify(report.summary)}`);
  console.log('\nFindings:');
  for (const finding of findings) console.log(`  • ${finding}`);
  if (onlyElsewhere.length > 0) {
    console.log('\nWhere the extra bid numbers were found:');
    for (const bid of onlyElsewhere.slice(0, 20)) console.log(`  ${bid} → ${(elsewhere.get(bid) ?? []).join(', ')}`);
  }
  console.log(`\nReport written to ${outPath}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
