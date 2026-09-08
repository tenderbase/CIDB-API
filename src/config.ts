import { z } from 'zod';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Boolean environment variable parser.
 *
 * `z.coerce.boolean()` must not be used for env vars: every non-empty string is
 * truthy in JavaScript, so `API_SYNC_ON_START=false` would coerce to `true`.
 * This helper accepts the usual spellings (true/false, 1/0, yes/no, on/off),
 * treats an unset or empty value as the default, and rejects anything else so a
 * typo fails loudly at boot instead of silently flipping behaviour.
 */
export function booleanish(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .refine((value) => {
      if (value === undefined) return true;
      const normalized = value.trim().toLowerCase();
      return normalized === '' || TRUTHY.has(normalized) || FALSY.has(normalized);
    }, { message: 'Must be a boolean: true/false, 1/0, yes/no or on/off' })
    .transform((value) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      return TRUTHY.has(normalized);
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().default('cidb-tender-api'),
  /**
   * Public origin of this deployment, e.g. https://cidb-tender-api.onrender.com.
   * Used to emit absolute OpenAPI `servers` URLs so the spec served at /docs and
   * exported to docs/openapi.yaml resolves in external tools and code generators.
   * Empty (default) keeps the relative `/api/v1` server, which is correct when
   * the docs are browsed on the same origin.
   */
  PUBLIC_BASE_URL: z
    .string()
    .default('')
    .refine((v) => v === '' || /^https?:\/\/[^\s/]+/.test(v), {
      message: 'Must be empty or an http(s) origin, e.g. https://cidb-tender-api.onrender.com',
    }),

  DATABASE_URL: z.string().default(''),
  DATABASE_URL_POOLED: z.string().optional(),
  /** postgres = Prisma (production). memory = in-process DB for local testing only. */
  DB_MODE: z.enum(['postgres', 'memory']).default('postgres'),
  /** API only: run one sync on boot (dev convenience; worker uses SYNC_ON_START). */
  API_SYNC_ON_START: booleanish(false),

  API_KEY: z.string().default(''),
  ADMIN_API_KEY: z.string().default(''),

  CIDB_SOURCE_URL: z
    .string()
    .default('https://www.cidb.org.za/cidb-tenders/current-tenders/')
    .refine((v) => v.startsWith('file:') || /^https?:\/\/.+/.test(v), {
      message: 'Must be an http(s) URL, or file:<path> for offline testing',
    }),
  CIDB_SYNC_CRON: z.string().default('*/30 * * * *'),
  SYNC_ON_START: booleanish(true),
  MISSING_CLOSE_GRACE_DAYS: z.coerce.number().int().min(0).default(3),
  MIN_EXPECTED_RECORDS: z.coerce.number().int().min(0).default(1),
  MAX_DROP_RATIO: z.coerce.number().min(0).max(1).default(0.8),
  CLOSING_SOON_DAYS: z.coerce.number().int().min(1).default(7),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  REQUEST_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  CIDB_USER_AGENT: z.string().default('CIDB-Tender-API/1.0 (+https://github.com/tenderbase; contact: TenderBase data service)'),

  CORS_ORIGIN: z.string().default(''),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  ADMIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Validate a raw environment mapping. Exported so tests can exercise the
 * parsing rules without mutating `process.env`.
 */
export function parseConfig(input: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export const config: AppConfig = parseConfig();

/** Parse CORS_ORIGIN allowlist (comma-separated). Empty array = CORS disabled. */
export function corsOrigins(): string[] {
  return config.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Configured public origin without a trailing slash ('' when not set). */
export function publicOrigin(): string {
  return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/**
 * OpenAPI server URLs for the versioned API. Absolute when PUBLIC_BASE_URL is
 * set (production), otherwise relative to the serving origin (local dev, tests).
 */
export function apiServerUrl(): string {
  return `${publicOrigin()}/api/v1`;
}

/** OpenAPI server URL for routes mounted at the service root (e.g. `GET /`). */
export function rootServerUrl(): string {
  return publicOrigin() || '/';
}
