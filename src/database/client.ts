import { config } from '../config.js';
import { logger } from '../utils/logging.js';
import { createMemoryDb } from './memory.js';
import { DbClient } from './types.js';

export type { DbClient } from './types.js';

/**
 * Lazy database client.
 *
 * - Production (`DB_MODE=postgres`): the real PrismaClient, constructed on
 *   first use (after `prisma generate` has run during the Docker build).
 * - Local testing (`DB_MODE=memory`): the in-process memory provider.
 * - Tests: an injected implementation via `__setDbClient()` (wins over both).
 *
 * The lazy proxy exists so importing this module never requires a live
 * database or a generated client — the API can boot (e.g. for OpenAPI
 * export) with only environment validation.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let injected: DbClient | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let real: any = null;
let memory: DbClient | null = null;

function createRealClient(): DbClient {
  if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_POOLED) {
    throw new Error('DATABASE_URL is required (set it in .env or the environment)');
  }
  if (process.env.DATABASE_URL_POOLED && !process.env.__POOLED_URL_APPLIED) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_POOLED;
    process.env.__POOLED_URL_APPLIED = '1';
  }
  // Resolved lazily so unit tests and OpenAPI export never load Prisma.
  // The structural DbClient interface (database/types.ts) mirrors the real
  // PrismaClient API; no static import keeps compile-time independent of
  // `prisma generate`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require('@prisma/client') as {
    PrismaClient: new (args?: Record<string, unknown>) => unknown;
  };
  return new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error'],
  }) as unknown as DbClient;
}

function target(): DbClient {
  if (injected) return injected;
  if (config.DB_MODE === 'memory') {
    if (!memory) {
      memory = createMemoryDb().db;
      logger.warn(
        { event: 'DB_MODE_MEMORY' },
        'Running with the in-memory database (DB_MODE=memory) — local testing only, data is not persisted',
      );
    }
    return memory;
  }
  if (!real) real = createRealClient();
  return real as DbClient;
}

/** Test hook: inject a fake DbClient. Pass null to restore the real client. */
export function __setDbClient(client: DbClient | null): void {
  injected = client;
  if (client === null) real = null;
}

/** The database client (lazy proxy — safe to import anywhere). */
export const prisma: DbClient = new Proxy({} as DbClient, {
  get: (_t, prop: string | symbol) => {
    const value = (target() as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(target()) : value;
  },
});

export async function checkDatabase(): Promise<{ connected: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { connected: true, latencyMs: Date.now() - start };
  } catch (error) {
    logger.error({ event: 'DATABASE_ERROR', error: (error as Error).message }, 'Database health check failed');
    return { connected: false, latencyMs: Date.now() - start };
  }
}
