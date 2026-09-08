import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTenderTable, parseCurrentTendersHtml, probeTenderTable } from '../../src/cidb/parser.js';
import { SourceStructureChangedError } from '../../src/cidb/types.js';
import * as cheerio from 'cheerio';

const FIXTURES = join(__dirname, '..', 'fixtures');
const SOURCE_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
const load = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('CIDB parser', () => {
  it('parses a normal listing page into structured records', () => {
    const records = parseCurrentTendersHtml(load('cidb-current.html'), SOURCE_URL);
    expect(records).toHaveLength(4);

    const first = records[0];
    expect(first.bidNumber).toBe('cidb 004 2627');
    expect(first.description).toContain('1250 KVA transformer');
    expect(first.publishedDate).toBe('Date Advertised: 2026-06-01');
    expect(first.sourceUrl).toBe(SOURCE_URL);
  });

  it('captures document links from both the Documents and Details columns', () => {
    const records = parseCurrentTendersHtml(load('cidb-current.html'), SOURCE_URL);
    const urls = records[0].documents.map((d) => d.url);
    // 2 from Documents column + 1 pricing schedule embedded in Details.
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('cidb-004-2627-tender-document');
    expect(urls).toContain(
      'https://www.cidb.org.za/wp-content/uploads/2026/06/Annexure-B-Transformer-and-Electrical-Installations-Unpriced-BOQ.xlsx',
    );
    expect(records[0].documents[0].label).toBe('GET BID DOCUMENT');
  });

  it('resolves relative document URLs against the source URL', () => {
    const records = parseCurrentTendersHtml(load('cidb-current.html'), SOURCE_URL);
    const kzn = records.find((r) => r.bidNumber === 'cidb 002 2526');
    expect(kzn?.documents[0].url).toBe('https://www.cidb.org.za/wp-content/tender-uploads/tender-document-kzn--cidb-002-2526.pdf');
  });

  it('tolerates rows with missing dates and missing documents', () => {
    const records = parseCurrentTendersHtml(load('cidb-current.html'), SOURCE_URL);
    const sparse = records.find((r) => r.bidNumber === 'cidb 011 2526');
    expect(sparse).toBeDefined();
    expect(sparse?.publishedDate).toBeNull();
    expect(sparse?.documents).toHaveLength(0);
  });

  it('locates columns by header meaning, not position', () => {
    const html = `<table><tr><th>Documents</th><th>Date</th><th>Bid Number</th><th>Details</th></tr>
      <tr><td><a href="https://x.test/d.pdf">GET BID DOCUMENT</a></td><td>Date Advertised: 2026-01-01</td><td>BID-1</td><td>Some work</td></tr></table>`;
    const records = parseCurrentTendersHtml(html, SOURCE_URL);
    expect(records).toHaveLength(1);
    expect(records[0].bidNumber).toBe('BID-1');
    expect(records[0].description).toBe('Some work');
  });

  it('throws SOURCE_STRUCTURE_CHANGED when no tender table exists', () => {
    expect(() => parseCurrentTendersHtml(load('cidb-no-table.html'), SOURCE_URL)).toThrowError(
      SourceStructureChangedError,
    );
    expect(() => parseCurrentTendersHtml(load('cidb-no-table.html'), SOURCE_URL)).toThrowError(
      /SOURCE_STRUCTURE_CHANGED/,
    );
  });

  it('throws SOURCE_STRUCTURE_CHANGED when the table has zero data rows', () => {
    expect(() => parseCurrentTendersHtml(load('cidb-empty.html'), SOURCE_URL)).toThrowError(
      /zero data rows/,
    );
  });

  it('throws when expected header concepts disappear', () => {
    const html = `<table><tr><th>Foo</th><th>Bar</th></tr><tr><td>a</td><td>b</td></tr></table>`;
    expect(() => parseCurrentTendersHtml(html, SOURCE_URL)).toThrowError(SourceStructureChangedError);
  });

  it('skips decorative rows without bid number and details', () => {
    const html = `<table><tr><th>Bid Number</th><th>Details</th><th>Date</th><th>Documents</th></tr>
      <tr><td colspan="4">Section: cleaning services</td></tr>
      <tr><td></td><td></td><td></td><td></td></tr>
      <tr><td>BID-9</td><td>Real tender</td><td>Date Advertised: 2026-02-02</td><td></td></tr></table>`;
    const records = parseCurrentTendersHtml(html, SOURCE_URL);
    expect(records).toHaveLength(1);
    expect(records[0].bidNumber).toBe('BID-9');
  });

  it('findTenderTable maps header synonyms', () => {
    const $ = cheerio.load(
      `<table><tr><th>Tender No</th><th>Description</th><th>Published</th><th>Downloads</th></tr></table>`,
    );
    const { columns } = findTenderTable($);
    expect(columns).toEqual({ bidNumber: 0, details: 1, date: 2, documents: 3 });
  });

  it('probeTenderTable never throws', () => {
    expect(probeTenderTable(load('cidb-current.html'))).toMatchObject({ found: true, rowCount: 4 });
    expect(probeTenderTable(load('cidb-no-table.html'))).toMatchObject({ found: false, rowCount: 0 });
    expect(probeTenderTable('not html at all {{{')).toMatchObject({ found: false });
  });
});
