import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, isRetryableFetchError, isRetryableHttpStatus, withRetry } from '../../src/utils/retry.js';

describe('retry utils', () => {
  it('classifies retryable HTTP statuses', () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('classifies retryable fetch errors', () => {
    expect(isRetryableFetchError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableFetchError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableFetchError(new Error('getaddrinfo EAI_AGAIN x'))).toBe(true);
    expect(isRetryableFetchError(new Error('totally unrelated'))).toBe(false);
    expect(isRetryableFetchError(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isRetryableFetchError(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
  });

  it('retries with exponential backoff then resolves', async () => {
    const fn = vi.fn();
    fn.mockRejectedValueOnce(new Error('fetch failed'));
    fn.mockRejectedValueOnce(new Error('fetch failed'));
    fn.mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, onRetry });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('throws the last error when retries are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('computes jittered exponential backoff', () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = backoffDelay(1000, attempt);
      const base = 1000 * 2 ** attempt;
      expect(d).toBeGreaterThanOrEqual(base * 0.75);
      expect(d).toBeLessThanOrEqual(base * 1.25);
    }
  });
});
