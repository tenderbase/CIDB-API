/**
 * The scraper rejects "suspiciously small" bodies by default — a truncated or
 * blocked page must not be mistaken for an empty result. Diagnostics (robots.txt,
 * an empty feed, a probe of a small page) legitimately need the opposite, so the
 * threshold is an option. These tests pin both behaviours against a real local
 * HTTP server.
 */
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchHtml, fetchJson } from '../../src/cidb/scraper.js';
import { SourceRequestError } from '../../src/cidb/types.js';

const TINY_BODY = '{"tender_count":"0","tm_tenders":[]}'; // 36 bytes — a legitimately empty feed

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(TINY_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchHtml minimum-size guard', () => {
  it('rejects a small body by default', async () => {
    await expect(fetchHtml(`${baseUrl}/tenders.json`, { maxRetries: 0 })).rejects.toThrowError(/suspiciously small/);
    await expect(fetchHtml(`${baseUrl}/tenders.json`, { maxRetries: 0 })).rejects.toThrowError(SourceRequestError);
  });

  it('accepts the same body when minBytes allows it', async () => {
    const result = await fetchHtml(`${baseUrl}/robots.txt`, { maxRetries: 0, minBytes: 0 });
    expect(result.status).toBe(200);
    expect(result.html).toBe(TINY_BODY);
  });

  it('honours a custom threshold', async () => {
    await expect(fetchHtml(`${baseUrl}/x`, { maxRetries: 0, minBytes: TINY_BODY.length + 1 })).rejects.toThrowError(
      /suspiciously small/,
    );
    await expect(
      fetchHtml(`${baseUrl}/x`, { maxRetries: 0, minBytes: TINY_BODY.length }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('lets fetchJson read an empty feed instead of failing the request', async () => {
    const { json } = await fetchJson(`${baseUrl}/tenders.json`, { maxRetries: 0, minBytes: 0 });
    expect(json).toEqual({ tender_count: '0', tm_tenders: [] });
  });
});
