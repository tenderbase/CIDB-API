/**
 * Feed probe (diagnostic, run from CI where cidb.org.za is reachable).
 *
 * The listing page asks `tenders.json` for `{page, limit, search_item, region,
 * status}` and pages through `tender_count`, but a plain request returns 25 rows
 * while `tender_count` declares 33 — and `?page=2` came back byte-identical to
 * page 1. This script asks the same endpoint the way the site does, plus a few
 * variants, and reports what actually changes:
 *
 *   • does `limit` resize a page, or is the response cached/fixed?
 *   • does `page` move the window at all?
 *   • do `status` / `region` / `search_item` filter the rows (and so, taken
 *     together, expose records the default response hides)?
 *   • how many DISTINCT tenders are reachable in total?
 *
 * Usage:
 *   npx tsx scripts/probe-feed.ts                       # → data/feed-probe.json
 *   npx tsx scripts/probe-feed.ts --out=artifacts/feed-probe.json --delay=2000
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractFeedEntries, feedDeclaredCount, feedEntryKey } from '../src/cidb/jsonFeed.js';
import { fetchJson } from '../src/cidb/scraper.js';
import { config } from '../src/config.js';

const FEED_URL = 'https://www.cidb.org.za/tenders.json';
/** The cache-buster the website itself sends (loadDataTable() in the page source). */
const SITE_CACHE_BUSTER = '7223253';

interface Variant {
  name: string;
  url: string;
  note?: string;
}

interface VariantResult {
  name: string;
  url: string;
  note?: string;
  ok: boolean;
  status?: number;
  bytes?: number;
  rows?: number;
  declaredTotal?: number | null;
  /** Distinct tender identities in this response. */
  keys?: string[];
  sampleBidNumbers?: string[];
  statuses?: Record<string, number>;
  error?: string;
}

interface ProbeReport {
  generatedAt: string;
  feedUrl: string;
  userAgent: string;
  variants: VariantResult[];
  distinctKeys: number;
  distinctBidNumbers: number;
  declaredTotal: number | null;
  findings: string[];
}

function variants(): Variant[] {
  const cacheBust = String(Date.now());
  const list: Variant[] = [
    { name: 'baseline', url: FEED_URL, note: 'no parameters at all' },
    {
      name: 'site-cache-buster',
      url: `${FEED_URL}?r=${SITE_CACHE_BUSTER}`,
      note: 'the ?r= token the website sends',
    },
    {
      name: 'fresh-cache-buster',
      url: `${FEED_URL}?r=${cacheBust}`,
      note: 'a new ?r= token — differs only if the response is URL-keyed cache',
    },
    { name: 'page-1-limit-10', url: `${FEED_URL}?page=1&limit=10`, note: 'does limit shrink the page?' },
    { name: 'page-2-limit-10', url: `${FEED_URL}?page=2&limit=10`, note: 'does page move the window?' },
    { name: 'page-2-limit-100', url: `${FEED_URL}?page=2&limit=100` },
    {
      name: 'site-exact-page-2',
      url: `${FEED_URL}?r=${SITE_CACHE_BUSTER}&page=2&limit=10&search_item=&region=&status=&_=${cacheBust}`,
      note: 'every parameter jQuery sends, including the cache-buster',
    },
    { name: 'status-open', url: `${FEED_URL}?status=Open`, note: 'server-side status filter' },
    { name: 'status-closed', url: `${FEED_URL}?status=Closed` },
    { name: 'status-awarded', url: `${FEED_URL}?status=Awarded` },
    { name: 'status-unknown', url: `${FEED_URL}?status=Unknown` },
    { name: 'region-1', url: `${FEED_URL}?region=1`, note: 'server-side region filter' },
    { name: 'region-2', url: `${FEED_URL}?region=2` },
    { name: 'search-road', url: `${FEED_URL}?search_item=road`, note: 'does search_item filter rows?' },
    { name: 'search-zzz', url: `${FEED_URL}?search_item=zzzznotatender`, note: 'expect 0 rows if honoured' },
  ];
  return list;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function probeVariant(variant: Variant): Promise<VariantResult> {
  try {
    const { json, raw, status } = await fetchJson(variant.url, { maxRetries: 1 });
    const entries = extractFeedEntries(json);
    const statuses: Record<string, number> = {};
    for (const entry of entries) {
      const key = String(entry.realstatus ?? entry.status ?? 'unknown');
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    return {
      name: variant.name,
      url: variant.url,
      note: variant.note,
      ok: true,
      status,
      bytes: raw.length,
      rows: entries.length,
      declaredTotal: feedDeclaredCount(json),
      keys: entries.map((entry) => feedEntryKey(entry)),
      sampleBidNumbers: entries.slice(0, 5).map((entry) => String(entry.bid_number ?? '').trim()),
      statuses,
    };
  } catch (error) {
    return {
      name: variant.name,
      url: variant.url,
      note: variant.note,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(results: VariantResult[]): string[] {
  const findings: string[] = [];
  const ok = results.filter((result) => result.ok);
  const baseline = ok.find((result) => result.name === 'baseline');

  const declared = ok.map((result) => result.declaredTotal).find((value) => value !== null && value !== undefined);
  const rowCounts = new Set(ok.map((result) => result.rows));
  const byteCounts = new Set(ok.map((result) => result.bytes));

  if (baseline) {
    findings.push(`baseline returns ${baseline.rows} rows and declares tender_count=${baseline.declaredTotal ?? 'n/a'}`);
  }
  findings.push(
    rowCounts.size === 1
      ? `every variant returned the same row count (${[...rowCounts][0]}) — the endpoint does not filter or page`
      : `row counts differ across variants (${[...rowCounts].sort((a, b) => (a ?? 0) - (b ?? 0)).join(', ')}) — some parameter is honoured`,
  );
  findings.push(
    byteCounts.size === 1
      ? `every variant returned byte-identical payloads (${[...byteCounts][0]} bytes) — consistent with a cached, parameter-insensitive response`
      : `payload sizes differ (${[...byteCounts].sort((a, b) => (a ?? 0) - (b ?? 0)).join(', ')} bytes)`,
  );

  const limit10 = ok.find((result) => result.name === 'page-1-limit-10');
  if (baseline && limit10) {
    findings.push(
      limit10.rows === baseline.rows
        ? `limit=10 is ignored (still ${limit10.rows} rows)`
        : `limit is honoured (limit=10 → ${limit10.rows} rows vs baseline ${baseline.rows})`,
    );
  }
  const page2 = ok.find((result) => result.name === 'page-2-limit-10' || result.name === 'page-2-limit-100');
  if (baseline && page2) {
    const baselineKeys = new Set(baseline.keys ?? []);
    const fresh = (page2.keys ?? []).filter((key) => !baselineKeys.has(key)).length;
    findings.push(
      fresh === 0
        ? `page=2 returns no records that page 1 did not already contain — paging is not honoured`
        : `page=2 adds ${fresh} new records — paging works`,
    );
  }
  const searchZzz = ok.find((result) => result.name === 'search-zzz');
  if (searchZzz) {
    findings.push(
      (searchZzz.rows ?? 0) === 0
        ? 'search_item is honoured (a nonsense search returns 0 rows)'
        : `search_item is ignored (a nonsense search still returns ${searchZzz.rows} rows)`,
    );
  }
  const statusRows = ok
    .filter((result) => result.name.startsWith('status-'))
    .map((result) => `${result.name}=${result.rows}`);
  if (statusRows.length > 0) findings.push(`status filter row counts: ${statusRows.join(', ')}`);
  const regionRows = ok.filter((result) => result.name.startsWith('region-')).map((result) => `${result.name}=${result.rows}`);
  if (regionRows.length > 0) findings.push(`region filter row counts: ${regionRows.join(', ')}`);

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) findings.push(`${failed.length} variant(s) failed: ${failed.map((f) => f.name).join(', ')}`);

  if (declared !== undefined && declared !== null) {
    findings.push(`source declares ${declared} tenders in total`);
  }
  return findings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outArg = args.find((arg) => arg.startsWith('--out='));
  const delayArg = args.find((arg) => arg.startsWith('--delay='));
  const outPath = outArg ? outArg.slice('--out='.length) : 'data/feed-probe.json';
  const delayMs = delayArg ? Number.parseInt(delayArg.slice('--delay='.length), 10) : config.REQUEST_DELAY_MS;

  const list = variants();
  console.log(`Probing ${FEED_URL} with ${list.length} variants (${delayMs}ms apart)\n`);

  const results: VariantResult[] = [];
  for (const [index, variant] of list.entries()) {
    const result = await probeVariant(variant);
    results.push(result);
    console.log(
      `${String(index + 1).padStart(2)}. ${variant.name.padEnd(22)} ` +
        (result.ok
          ? `HTTP ${result.status} ${String(result.bytes).padStart(6)}B rows=${String(result.rows).padStart(3)} ` +
            `declared=${result.declaredTotal ?? 'n/a'} statuses=${JSON.stringify(result.statuses)}`
          : `FAILED ${result.error}`),
    );
    if (index < list.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  const allKeys = new Set<string>();
  const allBids = new Set<string>();
  for (const result of results) {
    for (const key of result.keys ?? []) allKeys.add(key);
    for (const bid of result.sampleBidNumbers ?? []) allBids.add(bid);
  }
  // Union of full bid numbers requires the entries themselves; keys already
  // encode bid+description for entries without an id.
  const findings = summarize(results);
  findings.push(`${allKeys.size} DISTINCT tenders reachable across every variant`);

  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    feedUrl: FEED_URL,
    userAgent: config.CIDB_USER_AGENT,
    variants: results,
    distinctKeys: allKeys.size,
    distinctBidNumbers: allBids.size,
    declaredTotal: results.map((r) => r.declaredTotal).find((v) => v !== null && v !== undefined) ?? null,
    findings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\nFindings:');
  for (const finding of findings) console.log(`  • ${finding}`);
  console.log(`\nReport written to ${outPath}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
