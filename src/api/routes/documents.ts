import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../../auth/apiKey.js';
import { listDocumentsByTender } from '../../services/documentService.js';
import {
  authedErrorResponses,
  badRequestErrorSchema,
  notFoundErrorSchema,
  tenderDocumentsOkSchema,
} from '../../schemas/responses.js';
import { errorEnvelope } from '../app.js';

const idParam = z.object({
  id: z.string().min(1).max(100).describe('Internal tender id or the stable externalId (e.g. CIDB-CIDB-004-2627).'),
});

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireApiKey);

  r.get(
    '/tenders/:id/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'List tender documents',
        operationId: 'listTenderDocuments',
        description: 'Documents attached to a tender. Accepts the internal id or the stable externalId.',
        security: [{ apiKey: [] }],
        params: idParam,
        response: {
          200: tenderDocumentsOkSchema,
          400: badRequestErrorSchema,
          404: notFoundErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const docs = await listDocumentsByTender(request.params.id);
      if (!docs) return reply.status(404).send(errorEnvelope('NOT_FOUND', 'Tender not found'));
      return docs;
    },
  );
}
