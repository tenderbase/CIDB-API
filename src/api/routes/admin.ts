import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdminKey } from '../../auth/apiKey.js';
import { config } from '../../config.js';
import { prisma } from '../../database/client.js';
import { executeSyncRun, startSyncRun, SyncAlreadyRunningError } from '../../services/syncService.js';
import { logger } from '../../utils/logging.js';
import { errorsQuerySchema, syncHistoryQuerySchema } from '../../schemas/admin.js';
import {
  errorSchema,
  syncDetailResponseSchema,
  syncErrorsResponseSchema,
  syncHistoryResponseSchema,
  syncStartResponseSchema,
} from '../../schemas/responses.js';
import { errorEnvelope } from '../app.js';

const syncIdParam = z.object({ id: z.string().min(1).max(100) });

const strictRateLimit = {
  rateLimit: { max: config.ADMIN_RATE_LIMIT_MAX, timeWindow: config.ADMIN_RATE_LIMIT_WINDOW_MS },
};

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAdminKey);

  // Trigger a sync asynchronously — the HTTP request returns immediately.
  r.post(
    '/admin/sync',
    {
      config: strictRateLimit,
      schema: {
        tags: ['admin'],
        description: 'Trigger a CIDB synchronization. Runs asynchronously; poll GET /admin/sync/:id for progress.',
        security: [{ apiKey: [] }],
        response: { 202: syncStartResponseSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema },
      },
    },
    async (_request, reply) => {
      let syncId: string;
      try {
        syncId = await startSyncRun(prisma, 'CIDB');
      } catch (error) {
        if (error instanceof SyncAlreadyRunningError) {
          return reply
            .status(409)
            .send(errorEnvelope('SYNC_ALREADY_RUNNING', `A sync is already running (syncId=${error.syncId})`));
        }
        throw error;
      }
      // Fire-and-forget: never hold the HTTP request open for a scrape.
      setImmediate(() => {
        executeSyncRun(syncId).catch((error: unknown) => {
          logger.error(
            { event: 'SYNC_FAILED', syncId, error: (error as Error).message },
            'Background sync raised unexpectedly',
          );
        });
      });
      return reply.status(202).send({ status: 'started', syncId });
    },
  );

  r.get(
    '/admin/sync/history',
    {
      config: strictRateLimit,
      schema: {
        tags: ['admin'],
        description: 'Recent synchronization runs, newest first.',
        security: [{ apiKey: [] }],
        querystring: syncHistoryQuerySchema,
        response: { 200: syncHistoryResponseSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const { page, limit, status } = request.query;
      const where = status ? { status } : {};
      const [total, rows] = await Promise.all([
        prisma.syncRun.count({ where }),
        prisma.syncRun.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      return {
        data: rows.map((run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },
  );

  r.get(
    '/admin/sync/:id',
    {
      config: strictRateLimit,
      schema: {
        tags: ['admin'],
        description: 'Status and counters for one synchronization run, including its most recent errors.',
        security: [{ apiKey: [] }],
        params: syncIdParam,
        response: { 200: syncDetailResponseSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const run = await prisma.syncRun.findUnique({ where: { id: request.params.id } });
      if (!run) return reply.status(404).send(errorEnvelope('NOT_FOUND', 'Sync run not found'));
      const recentErrors = await prisma.syncError.findMany({
        where: { syncRunId: run.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return {
        ...run,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        recentErrors: recentErrors.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      };
    },
  );

  r.get(
    '/admin/errors',
    {
      config: strictRateLimit,
      schema: {
        tags: ['admin'],
        description: 'Recent ingestion errors across sync runs.',
        security: [{ apiKey: [] }],
        querystring: errorsQuerySchema,
        response: { 200: syncErrorsResponseSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const { page, limit, syncRunId, stage } = request.query;
      const where = {
        ...(syncRunId ? { syncRunId } : {}),
        ...(stage ? { stage } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.syncError.count({ where }),
        prisma.syncError.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      return {
        data: rows.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },
  );
}
