import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { logger } from '../utils/logging.js';
import { DiscoveredDocument, ParsedTender, SourceStructureChangedError } from './types.js';

/**
 * Expected columns of the CIDB current-tenders table. The parser locates
 * columns by header *meaning* (with synonyms) rather than fixed positions,
 * so harmless reordering/themes don't break ingestion — but if the expected
 * concepts disappear entirely the sync fails loudly instead of silently
 * returning zero records.
 */
const HEADER_SYNONYMS: Record<string, string[]> = {
  bidNumber: ['bid number', 'bid no', 'bid no.', 'tender number', 'tender no', 'reference', 'ref no'],
  details: ['details', 'detail', 'description', 'title', 'tender description', 'bid description'],
  date: ['date', 'dates', 'advertised', 'date advertised', 'published', 'published date', 'closing date'],
  documents: ['documents', 'document', 'downloads', 'download', 'bid document', 'attachments', 'links'],
};

interface ColumnMap {
  bidNumber: number;
  details: number;
  date: number;
  documents: number;
}

function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchColumn(header: string): keyof ColumnMap | null {
  const normalized = normalizeHeader(header);
  for (const [key, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    if (synonyms.some((s) => normalized === s || normalized.includes(s))) {
      return key as keyof ColumnMap;
    }
  }
  return null;
}

function extractLinks(
  $: cheerio.CheerioAPI,
  cell: cheerio.Cheerio<Element>,
  sourceUrl: string,
): DiscoveredDocument[] {
  const docs: DiscoveredDocument[] = [];
  cell.find('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href')?.trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return;
    let absolute: string;
    try {
      absolute = new URL(href, sourceUrl).toString();
    } catch {
      return;
    }
    const label = $(anchor).text().replace(/\s+/g, ' ').trim() || null;
    docs.push({ name: label ?? absolute, url: absolute, label });
  });
  return docs;
}

function cellText($: cheerio.CheerioAPI, cell: cheerio.Cheerio<Element>): string {
  // Preserve line breaks from <br> so multi-part details stay readable.
  const clone = cell.clone();
  clone.find('br').replaceWith('\n');
  return clone
    .text()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Locate the tender table: the first <table> whose header row contains a
 * "bid number" concept plus at least two of details/date/documents.
 */
export function findTenderTable($: cheerio.CheerioAPI): { table: cheerio.Cheerio<Element>; columns: ColumnMap } {
  const tables = $('table');
  if (tables.length === 0) {
    throw new SourceStructureChangedError(
      'SOURCE_STRUCTURE_CHANGED: no <table> elements found on the CIDB tender page',
    );
  }

  let bestCandidate: { table: cheerio.Cheerio<Element>; columns: Partial<ColumnMap>; score: number } | null = null;

  tables.each((_, table) => {
    const $table = $(table);
    // Header row: prefer <thead>, else the first row containing <th>, else first row.
    let headerCells = $table.find('thead tr').first().children('th, td');
    if (headerCells.length === 0) {
      const firstThRow = $table
        .find('tr')
        .filter((_, tr) => $(tr).find('th').length > 0)
        .first();
      headerCells = (firstThRow.length > 0 ? firstThRow : $table.find('tr').first()).children('th, td');
    }
    const columns: Partial<ColumnMap> = {};
    headerCells.each((index, cell) => {
      const key = matchColumn($(cell).text());
      if (key && columns[key] === undefined) columns[key] = index;
    });
    const score = Object.keys(columns).length;
    const hasBid = columns.bidNumber !== undefined;
    if (hasBid && score >= 3) {
      bestCandidate = { table: $table, columns: columns as ColumnMap, score: 100 + score };
      return false; // break: definitive match
    }
    if (score > (bestCandidate?.score ?? 0)) {
      bestCandidate = { table: $table, columns, score };
    }
    return undefined;
  });

  if (!bestCandidate || (bestCandidate as { score: number }).score < 100) {
    const found = bestCandidate ? Object.keys((bestCandidate as { columns: object }).columns) : [];
    throw new SourceStructureChangedError(
      `SOURCE_STRUCTURE_CHANGED: could not find the CIDB tender table (expected headers: bid number, details, date, documents; best match had: ${found.join(', ') || 'none'})`,
    );
  }

  const final = bestCandidate as { table: cheerio.Cheerio<Element>; columns: ColumnMap };
  return { table: final.table, columns: final.columns };
}

/** Rows that belong to the header (<thead> or <th>-only rows) are skipped. */
function isHeaderRow($: cheerio.CheerioAPI, row: Element): boolean {
  const $row = $(row);
  if ($row.closest('thead').length > 0) return true;
  const cells = $row.children('th, td');
  return cells.length > 0 && $row.children('td').length === 0;
}

function rowCells($: cheerio.CheerioAPI, row: Element): cheerio.Cheerio<Element> {
  return $(row).children('th, td') as unknown as cheerio.Cheerio<Element>;
}

/**
 * Parse the CIDB current-tenders listing HTML into structured records.
 *
 * @throws SourceStructureChangedError when the expected table/columns are missing.
 */
export function parseCurrentTendersHtml(html: string, sourceUrl: string): ParsedTender[] {
  const $ = cheerio.load(html);
  const { table, columns } = findTenderTable($);

  const records: ParsedTender[] = [];
  table.find('tr').each((_, row) => {
    if (isHeaderRow($, row)) return;
    const cells = rowCells($, row);
    // Single-cell rows are section banners (colspan), never tender records.
    if (cells.length <= 1) return;
    const get = (index: number): cheerio.Cheerio<Element> | null => {
      const cell = cells.eq(index);
      return cell.length > 0 ? (cell as unknown as cheerio.Cheerio<Element>) : null;
    };

    const bidCell = get(columns.bidNumber);
    const detailsCell = get(columns.details);
    const dateCell = get(columns.date);
    const docsCell = get(columns.documents);

    const bidNumber = bidCell ? cellText($, bidCell) || null : null;
    const detailsText = detailsCell ? cellText($, detailsCell) || null : null;
    const dateText = dateCell ? cellText($, dateCell) || null : null;

    // Skip decorative/section rows (e.g. colspan banners, empty rows).
    if (!bidNumber && !detailsText) return;

    // Document links live in the Documents column; the Details column often
    // embeds extra "Click here" links (pricing schedules, addenda) — capture all.
    const documents: DiscoveredDocument[] = [];
    if (docsCell) documents.push(...extractLinks($, docsCell, sourceUrl));
    if (detailsCell) documents.push(...extractLinks($, detailsCell, sourceUrl));

    records.push({
      bidNumber,
      title: null, // derived by the normalizer from description
      description: detailsText,
      organisation: null,
      publishedDate: dateText,
      closingDate: null,
      locationText: detailsText,
      documents,
      sourceUrl,
      extra: {
        bidNumberRaw: bidNumber,
        dateRaw: dateText,
      },
    });
  });

  logger.debug({ event: 'PARSE_COMPLETED', recordCount: records.length }, 'Parsed CIDB tender listing');

  if (records.length === 0) {
    // The table existed but yielded no data rows — page structure may have
    // changed (e.g. JS-rendered content). Fail loudly, never silently empty.
    throw new SourceStructureChangedError(
      'SOURCE_STRUCTURE_CHANGED: tender table found but contained zero data rows (content may now be JavaScript-rendered)',
    );
  }

  return records;
}

/** Best-effort extraction used by health checks (never throws). */
export function probeTenderTable(html: string): { found: boolean; columns: string[]; rowCount: number } {
  try {
    const $ = cheerio.load(html);
    const { table, columns } = findTenderTable($);
    let rowCount = 0;
    table.find('tr').each((_, row) => {
      if (!isHeaderRow($, row)) rowCount += 1;
    });
    return { found: true, columns: Object.keys(columns), rowCount };
  } catch {
    return { found: false, columns: [], rowCount: 0 };
  }
}

export type { AnyNode };
