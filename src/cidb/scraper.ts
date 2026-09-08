import { config } from '../config.js';
import { logger } from '../utils/logging.js';
import { isRetryableHttpStatus, sleep, withRetry } from '../utils/retry.js';
import { SourceRequestError } from './types.js';

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  userAgent?: string;
  /** Polite delay applied before the request (ms). */
  delayMs?: number;
}

export interface FetchResult {
  html: string;
  status: number;
  finalUrl: string;
  attempts: number;
}

export interface FetchJsonResult {
  json: unknown;
  raw: string;
  status: number;
  finalUrl: string;
  attempts: number;
}

function httpError(status: number, url: string): SourceRequestError {
  const error = new SourceRequestError(`CIDB request failed with HTTP ${status} for ${url}`, status);
  return error;
}

/**
 * Polite HTTP client for the CIDB website.
 *
 * - Descriptive User-Agent
 * - Request timeout via AbortController
 * - Exponential-backoff retries for transient failures (408/429/5xx, timeouts)
 * - Never hammers the source: callers add REQUEST_DELAY_MS between calls
 */
export async function fetchHtml(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const {
    timeoutMs = config.REQUEST_TIMEOUT_MS,
    maxRetries = config.MAX_RETRIES,
    baseDelayMs = config.RETRY_BASE_DELAY_MS,
    userAgent = config.CIDB_USER_AGENT,
    delayMs = 0,
  } = options;

  if (delayMs > 0) await sleep(delayMs);

  let attempts = 0;
  const html = await withRetry(
    async () => {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-ZA,en;q=0.9',
          },
          redirect: 'follow',
        });
        if (!response.ok) {
          if (response.status === 403 || response.status === 429) {
            logger.warn(
              { event: 'SOURCE_REQUEST_FAILED', url, status: response.status },
              'CIDB rate-limited or blocked the request; backing off',
            );
          }
          throw httpError(response.status, url);
        }
        const text = await response.text();
        if (!text || text.length < 500) {
          throw new SourceRequestError(`CIDB returned a suspiciously small response (${text.length} bytes) for ${url}`);
        }
        return text;
      } catch (error) {
        if (error instanceof SourceRequestError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          const timeoutError = new SourceRequestError(`CIDB request timed out after ${timeoutMs}ms for ${url}`);
          // Mark retryable so withRetry picks it up.
          (timeoutError as Error & { status?: number }).status = 408;
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries,
      baseDelayMs,
      isRetryable: (error) => {
        if (error instanceof SourceRequestError) {
          return error.status === undefined || isRetryableHttpStatus(error.status);
        }
        return true;
      },
      onRetry: (attempt, error, delayMsInner) => {
        logger.warn(
          {
            event: 'SOURCE_REQUEST_FAILED',
            url,
            attempt,
            delayMs: delayMsInner,
            error: error instanceof Error ? error.message : String(error),
          },
          'CIDB request failed, retrying with backoff',
        );
      },
    },
  );

  return { html, status: 200, finalUrl: url, attempts };
}

/**
 * Polite JSON fetch for the machine-readable CIDB feed (tenders.json).
 *
 * Same guarantees as fetchHtml — descriptive User-Agent, timeout, retry with
 * exponential backoff — plus a parse guard: a feed that stops being valid JSON
 * is a source-structure change, not an empty result.
 */
export async function fetchJson(url: string, options: FetchOptions = {}): Promise<FetchJsonResult> {
  const result = await fetchHtml(url, options);
  let json: unknown;
  try {
    json = JSON.parse(result.html) as unknown;
  } catch (error) {
    throw new SourceRequestError(
      `SOURCE_STRUCTURE_CHANGED: ${url} did not return valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  return { json, raw: result.html, status: result.status, finalUrl: result.finalUrl, attempts: result.attempts };
}
