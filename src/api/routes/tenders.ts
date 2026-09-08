import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../../auth/apiKey.js';
import {
  closingSoonTenders,
  getTenderById,
  listTenders,
  tendersByClass,
  tendersByGrade,
  tendersByProvince,
} from '../../services/tenderService.js';
import {
  closingSoonQuerySchema,
  paginationQuerySchema,
  searchQuerySchema,
  tenderListQuerySchema,
} from '../../schemas/query.js';
import {
  authedErrorResponses,
  badRequestErrorSchema,
  notFoundErrorSchema,
  tenderListOkSchema,
  tenderOkSchema,
} from '../../schemas/responses.js';
import { errorEnvelope } from '../app.js';

const idParam = z.object({
  id: z.string().min(1).max(100).describe('Internal tender id or the stable externalId (e.g. CIDB-CIDB-004-2627).'),
});
const provinceParam = z.object({
  province: z.string().min(1).max(100).describe('Province name, case-insensitive (e.g. Gauteng).'),
});
const gradeParam = z.object({
  grade: z.string().min(1).max(20).describe('CIDB contractor grade (e.g. 6 or 5-7).'),
});
const classParam = z.object({
  class: z.string().min(1).max(20).describe('CIDB class of works code (e.g. GB, CE, ME).'),
});

export async function registerTenderRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireApiKey);

  r.get(
    '/tenders',
    {
      schema: {
        tags: ['tenders'],
        summary: 'List tenders',
        operationId: 'listTenders',
        description: 'List tenders with search, filters, sorting and pagination.',
        security: [{ apiKey: [] }],
        querystring: tenderListQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => listTenders(request.query),
  );

  r.get(
    '/tenders/search',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Search tenders',
        operationId: 'searchTenders',
        description: 'Full-text style search across bid number, title, description, organisation and location.',
        security: [{ apiKey: [] }],
        querystring: searchQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => {
      const { q, page, limit } = request.query;
      return listTenders({
        page,
        limit,
        search: q,
        sort: 'publishedDate',
        order: 'desc',
      });
    },
  );

  r.get(
    '/tenders/closing-soon',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Tenders closing soon',
        operationId: 'listClosingSoonTenders',
        description: 'Open tenders with a closing date within the next N days.',
        security: [{ apiKey: [] }],
        querystring: closingSoonQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => {
      const { days, page, limit } = request.query;
      return closingSoonTenders(days, page, limit);
    },
  );

  r.get(
    '/tenders/province/:province',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Tenders by province',
        operationId: 'listTendersByProvince',
        description: 'Tenders for a single province (case-insensitive).',
        security: [{ apiKey: [] }],
        params: provinceParam,
        querystring: paginationQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => {
      const { page, limit } = request.query;
      return tendersByProvince(request.params.province, page, limit);
    },
  );

  r.get(
    '/tenders/grade/:grade',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Tenders by CIDB grade',
        operationId: 'listTendersByGrade',
        description: 'Tenders matching a CIDB grade. A single grade also matches ranges containing it (6 matches 5-7).',
        security: [{ apiKey: [] }],
        params: gradeParam,
        querystring: paginationQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => {
      const { page, limit } = request.query;
      return tendersByGrade(request.params.grade, page, limit);
    },
  );

  r.get(
    '/tenders/class/:class',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Tenders by CIDB class',
        operationId: 'listTendersByClass',
        description: 'Tenders matching a CIDB class of works (e.g. GB, CE, ME).',
        security: [{ apiKey: [] }],
        params: classParam,
        querystring: paginationQuerySchema,
        response: {
          200: tenderListOkSchema,
          400: badRequestErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request) => {
      const { page, limit } = request.query;
      return tendersByClass(request.params.class, page, limit);
    },
  );

  r.get(
    '/tenders/:id',
    {
      schema: {
        tags: ['tenders'],
        summary: 'Get one tender',
        operationId: 'getTender',
        description: 'Full tender detail including documents. Accepts the internal id or the stable externalId.',
        security: [{ apiKey: [] }],
        params: idParam,
        response: {
          200: tenderOkSchema,
          400: badRequestErrorSchema,
          404: notFoundErrorSchema,
          ...authedErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tender = await getTenderById(request.params.id);
      if (!tender) return reply.status(404).send(errorEnvelope('NOT_FOUND', 'Tender not found'));
      return tender;
    },
  );
}
