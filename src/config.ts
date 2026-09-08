import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().default('cidb-tender-api'),

  DATABASE_URL: z.string().default(''),
  DATABASE_URL_POOLED: z.string().optional(),
  /** postgres = Prisma (production). memory = in-process DB for local testing only. */
  DB_MODE: z.enum(['postgres', 'memory']).default('postgres'),
  /** API only: run one sync on boot (dev convenience; worker uses SYNC_ON_START). */
  API_SYNC_ON_START: z.coerce.boolean().default(false),

  API_KEY: z.string().default(''),
  ADMIN_API_KEY: z.string().default(''),

  CIDB_SOURCE_URL: z
    .string()
    .default('https://www.cidb.org.za/cidb-tenders/current-tenders/')
    .refine((v) => v.startsWith('file:') || /^https?:\/\/.+/.test(v), {
      message: 'Must be an http(s) URL, or file:<path> for offline testing',
    }),
  CIDB_SYNC_CRON: z.string().default('*/30 * * * *'),
  SYNC_ON_START: z.coerce.boolean().default(true),
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

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();

/** Parse CORS_ORIGIN allowlist (comma-separated). Empty array = CORS disabled. */
export function corsOrigins(): string[] {
  return config.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
