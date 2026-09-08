import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAdminKey } from '../../auth/apiKey.js';
import { createConnector } from '../../cidb/factory.js';
import { config } from '../../config.js';
import { checkDatabase, prisma } from '../../database/client.js';
import {
  detailedHealthOkSchema,
  forbiddenErrorSchema,
  healthDegradedSchema,
  healthOkSchema,
  rateLimitedErrorSchema,
  unauthorizedErrorSchema,
} from '../../schemas/responses.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Public liveness probe — also the Render health check.
  r.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        operationId: 'getHealth',
        description:
          'Public liveness probe — no API key required. This is the Render health check path. ' +
          'Returns 503 when the database is unreachable.',
        response: { 200: healthOkSchema, 503: healthDegradedSchema, 429: rateLimitedErrorSchema },
      },
    },
    async (_request, reply) => {
      const db = await checkDatabase();
      const body = {
        status: db.connected ? 'ok' : 'degraded',
        service: 'cidb-tender-api',
        database: db.connected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
      };
      return reply.status(db.connected ? 200 : 503).send(body);
    },
  );

  // Authenticated deep health: DB, source, worker, record counts.
  r.get(
    '/health/detailed',
    {
      preHandler: [requireAdminKey],
      schema: {
        tags: ['health'],
        summary: 'Detailed health',
        operationId: 'getDetailedHealth',
        description:
          'Detailed service status: database latency, CIDB source reachability, last sync run and record counts. ' +
          'Requires an ADMIN-role API key.',
        security: [{ apiKey: [] }],
        response: {
          200: detailedHealthOkSchema,
          401: unauthorizedErrorSchema,
          403: forbiddenErrorSchema,
          429: rateLimitedErrorSchema,
        },
      },
    },
    async () => {
      const [db, lastSync, lastSuccessful, runningSync, totalTenders, totalDocuments] = await Promise.all([
        checkDatabase(),
        prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
        prisma.syncRun.findFirst({
          where: { status: { in: ['COMPLETED', 'PARTIAL'] } },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.syncRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } }),
        prisma.tender.count(),
        prisma.tenderDocument.count(),
      ]);

      // Short, non-retrying probe — detailed health must stay fast.
      const connector = createConnector();
      const source = await connector.healthCheck().catch((error: unknown) => ({
        reachable: false,
        latencyMs: null as number | null,
        detail: error instanceof Error ? error.message : String(error),
      }));

      return {
        status: db.connected ? 'ok' : 'degraded',
        service: 'cidb-tender-api',
        timestamp: new Date().toISOString(),
        database: { connected: db.connected, latencyMs: db.latencyMs },
        source: {
          url: config.CIDB_SOURCE_URL,
          reachable: source.reachable,
          latencyMs: source.latencyMs,
          detail: source.detail ?? null,
        },
        worker: {
          lastSyncAt: lastSync?.startedAt.toISOString() ?? null,
          lastSyncStatus: lastSync?.status ?? null,
          lastSyncDurationMs: lastSync?.durationMs ?? null,
          lastSuccessfulSyncAt: lastSuccessful?.startedAt.toISOString() ?? null,
          runningSync: runningSync !== null,
        },
        records: { totalTenders, totalDocuments },
      };
    },
  );
}
