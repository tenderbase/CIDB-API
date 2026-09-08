/**
 * Configuration parsing tests.
 *
 * Regression focus: boolean env vars. `z.coerce.boolean()` treats every
 * non-empty string as true, so `API_SYNC_ON_START=false` used to enable the
 * boot sync — the opposite of what the operator wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { booleanish, parseConfig } from '../../src/config.js';

const TOUCHED_KEYS = ['PUBLIC_BASE_URL', 'API_SYNC_ON_START', 'SYNC_ON_START', 'PORT', 'RATE_LIMIT_MAX', 'MAX_DROP_RATIO'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

/** Re-import config.ts so its module-level `config` sees the given env. */
async function loadHelpers(env: Record<string, string>) {
  delete process.env.PUBLIC_BASE_URL;
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../src/config.js');
}

describe('booleanish', () => {
  it('parses the usual spellings, case-insensitively and trimmed', () => {
    const schema = booleanish(false);
    for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'ON']) {
      expect(schema.parse(value)).toBe(true);
    }
    for (const value of ['false', 'FALSE', ' False ', '0', 'no', 'OFF']) {
      expect(schema.parse(value)).toBe(false);
    }
  });

  it('falls back to the default when unset or empty', () => {
    expect(booleanish(true).parse(undefined)).toBe(true);
    expect(booleanish(true).parse('')).toBe(true);
    expect(booleanish(false).parse(undefined)).toBe(false);
    expect(booleanish(false).parse('   ')).toBe(false);
  });

  it('rejects values that are not booleans instead of guessing', () => {
    expect(booleanish(false).safeParse('maybe').success).toBe(false);
    expect(booleanish(false).safeParse('2').success).toBe(false);
  });
});

describe('parseConfig', () => {
  it('reads API_SYNC_ON_START=false as false (z.coerce.boolean regression)', () => {
    expect(parseConfig({ API_SYNC_ON_START: 'false' }).API_SYNC_ON_START).toBe(false);
    expect(parseConfig({ API_SYNC_ON_START: '0' }).API_SYNC_ON_START).toBe(false);
    expect(parseConfig({ API_SYNC_ON_START: 'true' }).API_SYNC_ON_START).toBe(true);
    expect(parseConfig({}).API_SYNC_ON_START).toBe(false);
  });

  it('reads SYNC_ON_START with a true default that can still be disabled', () => {
    expect(parseConfig({}).SYNC_ON_START).toBe(true);
    expect(parseConfig({ SYNC_ON_START: 'false' }).SYNC_ON_START).toBe(false);
    expect(parseConfig({ SYNC_ON_START: 'no' }).SYNC_ON_START).toBe(false);
  });

  it('fails loudly on a mistyped boolean', () => {
    expect(() => parseConfig({ API_SYNC_ON_START: 'perhaps' })).toThrow(/API_SYNC_ON_START/);
  });

  it('keeps other coercions intact', () => {
    const cfg = parseConfig({ PORT: '8080', RATE_LIMIT_MAX: '10', MAX_DROP_RATIO: '0.5' });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.RATE_LIMIT_MAX).toBe(10);
    expect(cfg.MAX_DROP_RATIO).toBe(0.5);
  });

  it('validates PUBLIC_BASE_URL', () => {
    expect(parseConfig({}).PUBLIC_BASE_URL).toBe('');
    expect(parseConfig({ PUBLIC_BASE_URL: 'https://cidb-tender-api.onrender.com' }).PUBLIC_BASE_URL).toBe(
      'https://cidb-tender-api.onrender.com',
    );
    expect(() => parseConfig({ PUBLIC_BASE_URL: 'cidb-tender-api.onrender.com' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => parseConfig({ PUBLIC_BASE_URL: 'ftp://example.com' })).toThrow(/PUBLIC_BASE_URL/);
  });
});

describe('server URL helpers', () => {
  it('is relative when PUBLIC_BASE_URL is unset', async () => {
    const mod = await loadHelpers({});
    expect(mod.publicOrigin()).toBe('');
    expect(mod.apiServerUrl()).toBe('/api/v1');
    expect(mod.rootServerUrl()).toBe('/');
  });

  it('is absolute when PUBLIC_BASE_URL is set, without a double slash', async () => {
    const mod = await loadHelpers({ PUBLIC_BASE_URL: 'https://cidb-tender-api.onrender.com/' });
    expect(mod.publicOrigin()).toBe('https://cidb-tender-api.onrender.com');
    expect(mod.apiServerUrl()).toBe('https://cidb-tender-api.onrender.com/api/v1');
    expect(mod.rootServerUrl()).toBe('https://cidb-tender-api.onrender.com');
  });
});
