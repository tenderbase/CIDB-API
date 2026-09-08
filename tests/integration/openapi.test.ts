/**
 * OpenAPI / Swagger UI contract tests.
 *
 * The document served at /docs is the public contract of this service, so it is
 * asserted here rather than eyeballed in a browser: it must be valid OpenAPI
 * 3.0, every operation must be summarized, tagged and documented with real
 * response descriptions (not "Default Response"), and routes mounted outside
 * `/api/v1` must carry their own `servers` entry so "Try it out" works.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildApp } from '../../src/api/app.js';
import { __setDbClient } from '../../src/database/client.js';
import { createMemoryDb } from '../helpers/fakeDb.js';

interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, unknown[]>>;
  servers?: Array<{ url: string }>;
  parameters?: Array<{ name: string; in: string; description?: string; schema?: Record<string, unknown> }>;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  externalDocs?: { url: string };
  components?: { securitySchemes?: Record<string, { type: string; name: string; in: string }> };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

let app: Awaited<ReturnType<typeof buildApp>>;
let doc: OpenApiDocument;

function operations(): Array<{ path: string; method: string; op: OpenApiOperation }> {
  const out: Array<{ path: string; method: string; op: OpenApiOperation }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method)) out.push({ path, method, op });
    }
  }
  return out;
}

beforeAll(async () => {
  const { db } = createMemoryDb();
  __setDbClient(db);
  app = await buildApp();
  await app.ready();
  doc = app.swagger() as OpenApiDocument;
}, 60_000);

afterAll(async () => {
  await app.close();
  __setDbClient(null);
});

describe('openapi document', () => {
  it('is valid OpenAPI 3.0', async () => {
    const validated = await SwaggerParser.validate(JSON.parse(JSON.stringify(doc)));
    expect(validated.openapi).toBe('3.0.3');
  });

  it('describes the service, its tags and its API-key scheme', () => {
    expect(doc.info.title).toBe('CIDB Tender API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.info.description).toMatch(/X-API-Key/);
    expect(doc.externalDocs?.url).toMatch(/^https:\/\/github\.com\/tenderbase\/CIDB-API/);
    expect(doc.components?.securitySchemes?.apiKey).toMatchObject({ type: 'apiKey', name: 'X-API-Key', in: 'header' });

    const declared = (doc.tags ?? []).map((tag) => tag.name);
    expect(declared).toEqual(['meta', 'health', 'tenders', 'documents', 'stats', 'admin']);
  });

  it('advertises a usable server URL', () => {
    // PUBLIC_BASE_URL is unset in tests → relative to the serving origin, which
    // is exactly what makes "Try it out" work when browsing /docs.
    expect(doc.servers?.[0]?.url).toBe('/api/v1');
  });

  it('documents every operation with a summary, description, tags and operationId', () => {
    const all = operations();
    expect(all.length).toBeGreaterThanOrEqual(16);

    const ids = new Set<string>();
    for (const { path, method, op } of all) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.summary, `${where} is missing a summary`).toBeTruthy();
      expect(op.description, `${where} is missing a description`).toBeTruthy();
      expect(op.operationId, `${where} is missing an operationId`).toBeTruthy();
      expect(ids.has(op.operationId!), `${where} reuses operationId ${op.operationId}`).toBe(false);
      ids.add(op.operationId!);

      expect(op.tags?.length, `${where} has no tag`).toBeGreaterThan(0);
      for (const tag of op.tags ?? []) {
        expect((doc.tags ?? []).map((t) => t.name), `${where} uses undeclared tag '${tag}'`).toContain(tag);
      }
    }
  });

  it('replaces every "Default Response" with a meaningful description', () => {
    for (const { path, method, op } of operations()) {
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        expect(
          response.description,
          `${method.toUpperCase()} ${path} ${status} has no response description`,
        ).toBeTruthy();
        expect(response.description).not.toMatch(/Default Response/i);
      }
    }
  });

  it('documents the error responses each route can actually return', () => {
    for (const { path, method, op } of operations()) {
      const statuses = Object.keys(op.responses ?? {});
      const secured = (op.security ?? []).some((entry) => 'apiKey' in entry);

      // Rate limiting is global, so every route can answer 429.
      expect(statuses, `${method.toUpperCase()} ${path} does not document 429`).toContain('429');

      if (secured) {
        expect(statuses, `${method.toUpperCase()} ${path} does not document 401`).toContain('401');
      }
      if (op.tags?.includes('admin') || path === '/health/detailed') {
        expect(statuses, `${method.toUpperCase()} ${path} does not document 403`).toContain('403');
      }
      // 4xx responses all use the shared error envelope.
      for (const status of statuses.filter((code) => code.startsWith('4'))) {
        const schema = op.responses?.[status]?.content?.['application/json']?.schema as
          | { properties?: { error?: unknown } }
          | undefined;
        expect(
          schema?.properties?.error,
          `${method.toUpperCase()} ${path} ${status} is not an error envelope`,
        ).toBeTruthy();
      }
    }
  });

  it('gives the root index its own server so "Try it out" does not hit /api/v1/', () => {
    const root = doc.paths['/']?.get;
    expect(root, 'GET / is missing from the document').toBeTruthy();
    expect(root.tags).toEqual(['meta']);
    // The document-wide server is /api/v1; without this override Swagger UI
    // would execute GET /api/v1/ and show a 404.
    expect(root.servers?.map((server) => server.url)).toEqual(['/']);
  });

  it('describes query parameters and their defaults', () => {
    const params = doc.paths['/tenders']?.get?.parameters ?? [];
    const byName = new Map(params.map((param) => [param.name, param]));
    for (const name of ['page', 'limit', 'search', 'status', 'province', 'cidbGrade', 'closingFrom', 'sort', 'order']) {
      expect(byName.get(name)?.description, `query param '${name}' has no description`).toBeTruthy();
    }
    expect(byName.get('page')?.schema).toMatchObject({ type: 'integer', default: 1 });
    expect(byName.get('limit')?.schema).toMatchObject({ type: 'integer', default: 25, maximum: 100 });
    expect(byName.get('status')?.schema).toMatchObject({ enum: expect.arrayContaining(['OPEN', 'CLOSED']) });
    expect(byName.get('closingFrom')?.description).toMatch(/ISO 8601/);
  });

  it('documents the degraded health body for 503', () => {
    const schema = doc.paths['/health']?.get?.responses?.['503']?.content?.['application/json']?.schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['status', 'service', 'database', 'timestamp']);
  });

  it('describes path parameters', () => {
    const params = doc.paths['/tenders/{id}']?.get?.parameters ?? [];
    const id = params.find((param) => param.name === 'id' && param.in === 'path');
    expect(id?.description).toMatch(/externalId/);
  });
});

describe('docs endpoints', () => {
  it('serves the Swagger UI page at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('swagger-ui');
  });

  it('persists the API key across docs reloads', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"persistAuthorization":true');
  });

  it('serves the JSON spec that matches app.swagger()', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('serves the same document as YAML', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/yaml' });
    expect(res.statusCode).toBe(200);
    const body = parseYaml(res.body) as OpenApiDocument;
    expect(body.info.title).toBe(doc.info.title);
    expect(Object.keys(body.paths).sort()).toEqual(Object.keys(doc.paths).sort());
  });

  it('keeps the spec public while the API stays authenticated', async () => {
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    const guarded = await app.inject({ method: 'GET', url: '/api/v1/tenders' });
    expect(guarded.statusCode).toBe(401);
  });
});
