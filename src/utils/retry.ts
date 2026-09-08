export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  /** Return true when the error is worth retrying. Defaults to retry-all. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export function isRetryableHttpStatus(status: number): boolean {
  // 429 + 5xx are transient; 408 also worth a retry.
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Timeouts, DNS hiccups, reset connections.
    if (/(timeout|timed out|abort|econnreset|econnrefused|enotfound|eai_again|econnaborted|socket hang up|fetch failed)/.test(msg)) {
      return true;
    }
    // Explicit HTTP status marker used by the scraper.
    const status = (error as Error & { status?: number }).status;
    if (typeof status === 'number') return isRetryableHttpStatus(status);
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter: base * 2^attempt ±25%. */
export function backoffDelay(baseDelayMs: number, attempt: number): number {
  const exp = baseDelayMs * 2 ** attempt;
  const jitter = exp * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Run `fn` with exponential-backoff retries. Throws the last error when
 * retries are exhausted or the error is not retryable.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs, isRetryable = isRetryableFetchError, onRetry } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = backoffDelay(baseDelayMs, attempt);
      onRetry?.(attempt + 1, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
