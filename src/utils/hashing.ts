import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short deterministic hash (first `length` hex chars of SHA-256). */
export function shortHash(input: string, length = 12): string {
  return sha256Hex(input).slice(0, length);
}

/**
 * Deterministic JSON serialization with sorted keys so hashes are stable
 * regardless of property insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deterministic content hash for change detection (rawHash). */
export function contentHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** Constant-time comparison of two hex hashes. Returns false on length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Hash a plaintext API key for storage (SHA-256). Never store plaintext keys. */
export function hashApiKey(plaintextKey: string): string {
  return sha256Hex(`cidb-api-key:v1:${plaintextKey}`);
}
