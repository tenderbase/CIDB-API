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
import { errorSchema, tenderListResponseSchema, tenderResponseSchema } from '../../schemas/responses.js';
import { errorEnvelope } from '../app.js';

const idParam = z.object({ id: z.string().min(1).max(100) });
const provinceParam = z.object({ province: z.string().min(1).max(100) });
const gradeParam = z.object({ grade: z.string().min(1).max(20) });
const classParam = z.object({ class: z.string().min(1).max(20) });

export async function registerTenderRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireApiKey);

  r.get(
    '/tenders',
    {
      schema: {
        tags: ['tenders'],
        description: 'List tenders with search, filters, sorting and pagination.',
        security: [{ apiKey: [] }],
        querystring: tenderListQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
      },
    },
    async (request) => listTenders(request.query),
  );

  r.get(
    '/tenders/search',
    {
      schema: {
        tags: ['tenders'],
        description: 'Full-text style search across bid number, title, description, organisation and location.',
        security: [{ apiKey: [] }],
        querystring: searchQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
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
        description: 'Open tenders with a closing date within the next N days.',
        security: [{ apiKey: [] }],
        querystring: closingSoonQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
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
        description: 'Tenders for a single province (case-insensitive).',
        security: [{ apiKey: [] }],
        params: provinceParam,
        querystring: paginationQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
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
        description: 'Tenders matching a CIDB grade. A single grade also matches ranges containing it (6 matches 5-7).',
        security: [{ apiKey: [] }],
        params: gradeParam,
        querystring: paginationQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
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
        description: 'Tenders matching a CIDB class of works (e.g. GB, CE, ME).',
        security: [{ apiKey: [] }],
        params: classParam,
        querystring: paginationQuerySchema,
        response: { 200: tenderListResponseSchema, 400: errorSchema, 401: errorSchema },
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
        description: 'Full tender detail including documents. Accepts the internal id or the stable externalId.',
        security: [{ apiKey: [] }],
        params: idParam,
        response: { 200: tenderResponseSchema, 401: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const tender = await getTenderById(request.params.id);
      if (!tender) return reply.status(404).send(errorEnvelope('NOT_FOUND', 'Tender not found'));
      return tender;
    },
  );
}
