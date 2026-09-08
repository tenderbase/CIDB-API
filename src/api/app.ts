import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { FastifyBaseLogger } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config, corsOrigins } from '../config.js';
import { logger } from '../utils/logging.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerTenderRoutes } from './routes/tenders.js';

export function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 1024 * 1024, // 1 MB — this API takes no large payloads
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      const allowlist = corsOrigins();
      // No Origin header (curl, server-to-server like the TenderBase backend) → allow.
      if (!origin) return cb(null, true);
      if (allowlist.length === 0) return cb(null, false);
      if (allowlist.includes('*') || allowlist.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'CIDB Tender API',
        version: '1.0.0',
        description:
          'Standalone normalized API over publicly available CIDB tender information. ' +
          'Authenticate with the `X-API-Key` header. Source: Construction Industry Development Board (CIDB).',
      },
      servers: [{ url: '/api/v1', description: 'Current server (v1)' }],
      tags: [
        { name: 'health', description: 'Service health and status' },
        { name: 'tenders', description: 'Tender search, filter and detail' },
        { name: 'documents', description: 'Tender documents' },
        { name: 'stats', description: 'Aggregate statistics' },
        { name: 'admin', description: 'Synchronization control (admin key required)' },
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header', description: 'API key issued for this service' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Consistent error envelope for every failure mode.
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const first = error.validation[0];
      const path = first.instancePath ? first.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'request';
      return reply.status(400).send(errorEnvelope('INVALID_REQUEST', `${path}: ${first.message}`));
    }
    const err = error as { statusCode?: number; validation?: unknown; code?: string; message: string };
    const status = err.statusCode ?? 500;
    if (status === 400 && err.validation) {
      return reply.status(400).send(errorEnvelope('INVALID_REQUEST', err.message));
    }
    if (status === 404) {
      return reply.status(404).send(errorEnvelope('NOT_FOUND', `No route matches ${request.method} ${request.url}`));
    }
    if (status === 429) {
      return reply.status(429).send(errorEnvelope('RATE_LIMITED', 'Too many requests, please slow down'));
    }
    if (status >= 500) {
      app.log.error({ err: error }, 'Unhandled request error');
      const message = config.NODE_ENV === 'production' ? 'Internal server error' : err.message;
      return reply.status(500).send(errorEnvelope('INTERNAL_ERROR', message));
    }
    return reply.status(status).send(errorEnvelope(err.code ?? 'REQUEST_ERROR', err.message));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(errorEnvelope('NOT_FOUND', `No route matches ${request.method} ${request.url}`));
  });

  // Each group gets its own encapsulated context so per-group preHandler
  // hooks (API vs admin auth) never leak onto other routes.
  await app.register(
    async (v1) => {
      await v1.register(registerHealthRoutes);
      await v1.register(registerTenderRoutes);
      await v1.register(registerDocumentRoutes);
      await v1.register(registerStatsRoutes);
      await v1.register(registerAdminRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Public service index so GET / (e.g. opening the deploy URL in a browser)
  // explains the service instead of 404ing. Not part of the versioned API.
  const rootResponseSchema = z.object({
    service: z.string(),
    version: z.string(),
    description: z.string(),
    docs: z.string(),
    openapi: z.string(),
    health: z.string(),
    api: z.string(),
  });
  app.get(
    '/',
    {
      schema: {
        description: 'Service index with links to documentation and health.',
        response: { 200: rootResponseSchema },
      },
    },
    async () => ({
      service: 'cidb-tender-api',
      version: '1.0.0',
      description: 'Standalone normalized API over publicly available CIDB tender information.',
      docs: '/docs',
      openapi: '/docs/json',
      health: '/api/v1/health',
      api: '/api/v1/tenders',
    }),
  );

  return app;
}
