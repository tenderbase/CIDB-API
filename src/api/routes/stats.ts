import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireApiKey } from '../../auth/apiKey.js';
import { getStats } from '../../services/statsService.js';
import { errorSchema, statsResponseSchema } from '../../schemas/responses.js';

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/stats',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['stats'],
        description: 'Aggregate tender counts, sync freshness and breakdowns by province, grade and class.',
        security: [{ apiKey: [] }],
        response: { 200: statsResponseSchema, 401: errorSchema },
      },
    },
    async () => getStats(),
  );
}
