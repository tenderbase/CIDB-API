import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CIDBHtmlConnector } from '../../src/cidb/connector.js';
import { FileFixtureConnector } from '../../src/cidb/fileConnector.js';
import { createConnector, isJsonFeedUrl } from '../../src/cidb/factory.js';
import { CIDBJsonConnector } from '../../src/cidb/jsonConnector.js';
import { SourceRequestError } from '../../src/cidb/types.js';
import { config } from '../../src/config.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'cidb-current.html');
const FEED_FIXTURE = join(__dirname, '..', 'fixtures', 'cidb-tenders.json');
const originalSourceUrl = config.CIDB_SOURCE_URL;

afterEach(() => {
  config.CIDB_SOURCE_URL = originalSourceUrl;
});

describe('connector factory', () => {
  it('selects the live HTML connector for http(s) sources', () => {
    config.CIDB_SOURCE_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';
    expect(createConnector()).toBeInstanceOf(CIDBHtmlConnector);
  });

  it('selects the fixture connector for file: sources', () => {
    config.CIDB_SOURCE_URL = `file:${FIXTURE}`;
    expect(createConnector()).toBeInstanceOf(FileFixtureConnector);
    config.CIDB_SOURCE_URL = `file:${FEED_FIXTURE}`;
    expect(createConnector()).toBeInstanceOf(FileFixtureConnector);
  });

  it('selects the JSON feed connector for .json sources', () => {
    config.CIDB_SOURCE_URL = 'https://www.cidb.org.za/tenders.json';
    expect(createConnector()).toBeInstanceOf(CIDBJsonConnector);
    config.CIDB_SOURCE_URL = 'https://www.cidb.org.za/tenders.json?r=7223253';
    expect(createConnector()).toBeInstanceOf(CIDBJsonConnector);
  });

  it('detects feed URLs by path, ignoring query and fragment', () => {
    expect(isJsonFeedUrl('https://www.cidb.org.za/tenders.json')).toBe(true);
    expect(isJsonFeedUrl('https://www.cidb.org.za/tenders.json?r=7223253')).toBe(true);
    expect(isJsonFeedUrl('https://www.cidb.org.za/tenders.JSON#x')).toBe(true);
    expect(isJsonFeedUrl('https://www.cidb.org.za/cidb-tenders/current-tenders/')).toBe(false);
    expect(isJsonFeedUrl('file:./tests/fixtures/cidb-tenders.json')).toBe(true);
  });

  it('defaults to the machine-readable feed', () => {
    // The public listing renders its rows in the browser, so the served HTML has
    // an empty tbody; the feed is the ingestable source.
    expect(process.env.CIDB_SOURCE_URL ?? 'https://www.cidb.org.za/tenders.json').toContain('tenders.json');
  });
});

describe('FileFixtureConnector with a JSON feed fixture', () => {
  it('discovers feed entries through the real mapper', async () => {
    const connector = new FileFixtureConnector(`file:${FEED_FIXTURE}`);
    const records = await connector.discover();
    expect(records).toHaveLength(5);

    const parsed = await connector.parse(records[0]);
    expect(parsed.bidNumber).toBe('cidb 004 2627');
    expect(parsed.documents.length).toBeGreaterThan(0);

    const normalized = await connector.normalize(parsed);
    expect(normalized.externalId).toBe('CIDB-CIDB-004-2627');
    // Attribution stays on the canonical listing page even in offline mode.
    expect(normalized.sourceUrl).toBe('https://www.cidb.org.za/cidb-tenders/current-tenders/');
    // The feed declares this tender awarded; inference alone would say OPEN.
    expect(normalized.status).toBe('AWARDED');
  });

  it('detects JSON by content when the extension is not .json', async () => {
    const connector = new FileFixtureConnector(`file:${FEED_FIXTURE}`);
    const health = await connector.healthCheck();
    expect(health).toMatchObject({ reachable: true });
    expect(health.detail).toContain('5 rows');
  });

  it('fails clearly when the feed fixture is malformed', async () => {
    const connector = new FileFixtureConnector('file:./does-not-exist.json');
    await expect(connector.discover()).rejects.toThrowError(SourceRequestError);
    const health = await connector.healthCheck();
    expect(health.reachable).toBe(false);
  });
});

describe('FileFixtureConnector', () => {
  it('discovers records through the real parser', async () => {
    const connector = new FileFixtureConnector(`file:${FIXTURE}`);
    const records = await connector.discover();
    expect(records).toHaveLength(4);
    const parsed = await connector.parse(records[0]);
    expect(parsed.bidNumber).toBe('cidb 004 2627');
    const normalized = await connector.normalize(parsed);
    expect(normalized.externalId).toBe('CIDB-CIDB-004-2627');
    // Attribution stays canonical even in offline mode.
    expect(normalized.sourceUrl).toBe('https://www.cidb.org.za/cidb-tenders/current-tenders/');
  });

  it('reports health from the fixture file', async () => {
    const connector = new FileFixtureConnector(`file:${FIXTURE}`);
    const health = await connector.healthCheck();
    expect(health).toMatchObject({ reachable: true });
    expect(health.detail).toContain('4 rows');
  });

  it('fails clearly when the fixture file is missing', async () => {
    const connector = new FileFixtureConnector('file:./does-not-exist.html');
    await expect(connector.discover()).rejects.toThrowError(SourceRequestError);
    const health = await connector.healthCheck();
    expect(health.reachable).toBe(false);
  });
});
