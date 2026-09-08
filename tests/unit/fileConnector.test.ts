import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CIDBHtmlConnector } from '../../src/cidb/connector.js';
import { createConnector } from '../../src/cidb/factory.js';
import { FileFixtureConnector } from '../../src/cidb/fileConnector.js';
import { SourceRequestError } from '../../src/cidb/types.js';
import { config } from '../../src/config.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'cidb-current.html');
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
