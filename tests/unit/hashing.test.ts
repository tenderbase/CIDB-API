import { describe, expect, it } from 'vitest';
import { contentHash, hashApiKey, safeEqualHex, sha256Hex, shortHash, stableStringify } from '../../src/utils/hashing.js';

describe('hashing utils', () => {
  it('computes stable SHA-256 digests', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(shortHash('hello', 8)).toBe('2cf24dba');
  });

  it('serializes objects with sorted keys', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(stableStringify({ a: 1, nested: { z: 1, a: [3, 2] } })).toBe('{"a":1,"nested":{"a":[3,2],"z":1}}');
  });

  it('produces order-independent content hashes', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('compares hashes in constant time', () => {
    expect(safeEqualHex('abc', 'abc')).toBe(true);
    expect(safeEqualHex('abc', 'abd')).toBe(false);
    expect(safeEqualHex('abc', 'abcd')).toBe(false);
  });

  it('hashes API keys with domain separation', () => {
    const h1 = hashApiKey('secret-1');
    expect(h1).toHaveLength(64);
    expect(h1).toBe(hashApiKey('secret-1'));
    expect(h1).not.toBe(hashApiKey('secret-2'));
    expect(h1).not.toBe(sha256Hex('secret-1'));
  });
});
