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
import { apiServerUrl, config, corsOrigins, publicOrigin, rootServerUrl } from '../config.js';
import { rateLimitedErrorSchema } from '../schemas/responses.js';
import { logger } from '../utils/logging.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerTenderRoutes } from './routes/tenders.js';

export function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

/** OpenAPI `servers` for the versioned API (see PUBLIC_BASE_URL in config.ts). */
export function apiServers(): Array<{ url: string; description: string }> {
  const origin = publicOrigin();
  if (!origin) return [{ url: apiServerUrl(), description: 'CIDB Tender API v1 (this origin)' }];
  return [
    { url: apiServerUrl(), description: 'CIDB Tender API v1 (public deployment)' },
    { url: '/api/v1', description: 'CIDB Tender API v1 (this origin)' },
  ];
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
          'Source: Construction Industry Development Board (CIDB).\n\n' +
          '### Authentication\n\n' +
          'Every endpoint except `GET /health` and `GET /` needs an API key: click **Authorize** and paste the ' +
          'key value (the `X-API-Key` header is added automatically). Read endpoints accept any active key; ' +
          '`/admin/*` and `/health/detailed` need an **ADMIN**-role key.\n\n' +
          '### Errors\n\n' +
          'All failures use one envelope: `{ "error": { "code": "...", "message": "..." } }` — ' +
          '`400` invalid request, `401` missing/invalid key, `403` admin key required, `404` not found, ' +
          '`409` sync already running, `429` rate limited, `500`/`503` service fault.\n\n' +
          '### Rate limits\n\n' +
          `Global: ${config.RATE_LIMIT_MAX} requests per ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)}s. ` +
          `Admin routes: ${config.ADMIN_RATE_LIMIT_MAX} per ${Math.round(config.ADMIN_RATE_LIMIT_WINDOW_MS / 1000)}s.`,
      },
      // PUBLIC_BASE_URL configured (production) → advertise the absolute origin
      // first (what code generators and external clients need) plus the relative
      // one, so "Try it out" keeps working when browsing the docs on any origin.
      // Unset (local dev, tests) → relative only.
      servers: apiServers(),
      externalDocs: {
        url: 'https://github.com/tenderbase/CIDB-API',
        description: 'Repository, ingestion pipeline and deployment notes',
      },
      tags: [
        { name: 'meta', description: 'Service metadata (no API key required)' },
        { name: 'health', description: 'Service health and status' },
        { name: 'tenders', description: 'Tender search, filter and detail' },
        { name: 'documents', description: 'Tender documents' },
        { name: 'stats', description: 'Aggregate statistics' },
        { name: 'admin', description: 'Synchronization control (admin key required)' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description:
              'API key issued for this service. Read endpoints accept any active key; ' +
              'admin endpoints require an ADMIN-role key.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      // Keep the X-API-Key across reloads and show a readable, compact UI.
      persistAuthorization: true,
      docExpansion: 'list',
      displayRequestDuration: true,
      defaultModelsExpandDepth: 0,
    },
  });

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
        tags: ['meta'],
        summary: 'Service index',
        operationId: 'getServiceIndex',
        description:
          'Public service index with links to the documentation, OpenAPI spec and health probe. ' +
          'No API key required.',
        // The document-wide server is `/api/v1`, so this root-level route needs
        // its own server entry — otherwise "Try it out" in Swagger UI would call
        // `/api/v1/` and get a 404.
        servers: [{ url: rootServerUrl(), description: 'Service root' }],
        response: {
          200: rootResponseSchema.describe('Service name, version and links to docs, health and the API.'),
          429: rateLimitedErrorSchema,
        },
      },
    },
    async () => ({
      service: config.SERVICE_NAME,
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
