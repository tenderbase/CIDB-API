import pino from 'pino';

/**
 * Structured JSON logger (Pino).
 *
 * Standard fields: timestamp, level, service, event, syncId, tenderId,
 * externalId, error. Never log secrets (API keys, DATABASE_URL).
 */
export const LOG_EVENTS = {
  SYNC_STARTED: 'SYNC_STARTED',
  SYNC_COMPLETED: 'SYNC_COMPLETED',
  SYNC_FAILED: 'SYNC_FAILED',
  TENDER_CREATED: 'TENDER_CREATED',
  TENDER_UPDATED: 'TENDER_UPDATED',
  TENDER_UNCHANGED: 'TENDER_UNCHANGED',
  TENDER_CLOSED: 'TENDER_CLOSED',
  DOCUMENT_DISCOVERED: 'DOCUMENT_DISCOVERED',
  SOURCE_REQUEST_FAILED: 'SOURCE_REQUEST_FAILED',
  SOURCE_STRUCTURE_CHANGED: 'SOURCE_STRUCTURE_CHANGED',
  SUSPICIOUS_ZERO_RESULTS: 'SUSPICIOUS_ZERO_RESULTS',
  DATABASE_ERROR: 'DATABASE_ERROR',
  SYNC_SKIPPED_OVERLAP: 'SYNC_SKIPPED_OVERLAP',
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const service = process.env.SERVICE_NAME ?? 'cidb-tender-api';

export const logger = pino({
  level: level === 'silent' ? 'silent' : level,
  base: { service },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
