/**
 * API integration tests: real Fastify app (validation, auth, serialization)
 * against the in-memory DbClient. Zod response schemas validate every
 * payload shape automatically via the serializer compiler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { __setDbClient, prisma } from '../../src/database/client.js';
import { DbClient } from '../../src/database/types.js';
import { createMemoryDb, seedApiKey, seedTender } from '../helpers/fakeDb.js';

const API_KEY = 'test-api-key-123';
const ADMIN_KEY = 'test-admin-key-456';
const DAY = 86_400_000;

let app: Awaited<ReturnType<typeof buildApp>>;
let db: DbClient;
let tenderIds: { t1: string; t2: string; t3: string; t4: string };

async function pollSync(syncId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/sync/${syncId}`,
      headers: { 'x-api-key': ADMIN_KEY },
    });
    const body = res.json() as { status: string };
    if (body.status !== 'RUNNING') return body as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error('timed out waiting for sync to finish');
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  ({ db } = createMemoryDb());
  __setDbClient(db);

  await seedApiKey(db, { name: 'test-api', plaintext: API_KEY, role: 'API' });
  await seedApiKey(db, { name: 'test-admin', plaintext: ADMIN_KEY, role: 'ADMIN' });

  const now = Date.now();
  const t1 = await seedTender(db, {
    externalId: 'CIDB-T1',
    bidNumber: 'BID-T1',
    title: 'Transformer maintenance services',
    province: 'Gauteng',
    status: 'OPEN',
    cidbGrade: '6',
    cidbClass: ['CE'],
    publishedDate: new Date(now - 30 * DAY),
    closingDate: new Date(now + 90 * DAY),
    documents: {
      create: [
        {
          name: 'GET BID DOCUMENT',
          documentType: 'BID_DOCUMENT',
          url: 'https://x.test/t1.pdf',
          sourceUrl: 'https://x.test/source',
          fileName: 't1.pdf',
          mimeType: 'application/pdf',
        },
      ],
    },
  });
  const t2 = await seedTender(db, {
    externalId: 'CIDB-T2',
    bidNumber: 'BID-T2',
    title: 'Rural road construction and surfacing',
    description: 'Gravel road construction in eThekwini region with surfacing works.',
    province: 'KwaZulu-Natal',
    status: 'OPEN',
    cidbGrade: '5-7',
    cidbClass: ['GB', 'CE'],
    publishedDate: new Date(now - 10 * DAY),
    closingDate: new Date(now + 3 * DAY),
  });
  const t3 = await seedTender(db, {
    externalId: 'CIDB-T3',
    bidNumber: 'BID-T3',
    title: 'Office accommodation in Cape Town',
    province: 'Western Cape',
    status: 'CLOSED',
    publishedDate: new Date(now - 60 * DAY),
    closingDate: new Date(now - 5 * DAY),
  });
  const t4 = await seedTender(db, {
    externalId: 'CIDB-T4',
    bidNumber: 'BID-T4',
    title: 'Unspecified consulting work',
    province: 'Gauteng',
    status: 'UNKNOWN',
    cidbGrade: null,
    publishedDate: null,
    closingDate: null,
  });
  tenderIds = { t1: t1.id, t2: t2.id, t3: t3.id, t4: t4.id };

  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  __setDbClient(null);
});

describe('service index', () => {
  it('serves a public index at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      service: 'cidb-tender-api',
      version: '1.0.0',
      docs: '/docs',
      health: '/api/v1/health',
    });
  });
});

describe('health', () => {
  it('serves the public health probe without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'cidb-tender-api', database: 'connected' });
  });

  it('requires an admin key for detailed health', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/health/detailed' });
    expect(anon.statusCode).toBe(401);
    const api = await app.inject({
      method: 'GET',
      url: '/api/v1/health/detailed',
      headers: { 'x-api-key': API_KEY },
    });
    expect(api.statusCode).toBe(403);
    expect(api.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('returns detailed health for admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health/detailed',
      headers: { 'x-api-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      records: { totalTenders: 4, totalDocuments: 1 },
      worker: { runningSync: false },
    });
    expect(body).toHaveProperty('database.connected', true);
    expect(body).toHaveProperty('source.url');
  });
});

describe('tender listing', () => {
  it('rejects unauthenticated and wrong-key requests', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/tenders' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders',
      headers: { 'x-api-key': 'wrong' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('lists tenders with pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders?page=1&limit=2',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; pagination: Record<string, number> };
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
  });

  it('returns the TenderBase-compatible tender shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders?limit=1',
      headers: { 'x-api-key': API_KEY },
    });
    const item = (res.json() as { data: Array<Record<string, unknown>> }).data[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'bidNumber', 'briefingDate', 'briefingLocation', 'briefingRequired', 'cidbClass', 'cidbGrade',
        'closingDate', 'contact', 'createdAt', 'description', 'documents', 'estimatedValue', 'externalId',
        'firstSeenAt', 'id', 'lastSeenAt', 'location', 'municipality', 'organisation', 'province',
        'publishedDate', 'source', 'sourceUrl', 'status', 'tenderType', 'title', 'updatedAt',
      ].sort(),
    );
    expect(Object.keys(item.contact as Record<string, unknown>).sort()).toEqual(['email', 'name', 'phone']);
  });

  it('filters by status (OPEN includes CLOSING_SOON)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders?status=OPEN',
      headers: { 'x-api-key': API_KEY },
    });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
    const closed = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders?status=CLOSED',
      headers: { 'x-api-key': API_KEY },
    });
    expect((closed.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it('filters by province, grade and class', async () => {
    const headers = { 'x-api-key': API_KEY };
    const gp = await app.inject({ method: 'GET', url: '/api/v1/tenders?province=gauteng', headers });
    expect((gp.json() as { data: unknown[] }).data).toHaveLength(2);
    const grade = await app.inject({ method: 'GET', url: '/api/v1/tenders?cidbGrade=6', headers });
    expect((grade.json() as { data: unknown[] }).data).toHaveLength(1);
    const klass = await app.inject({ method: 'GET', url: '/api/v1/tenders?cidbClass=ce', headers });
    expect((klass.json() as { data: unknown[] }).data).toHaveLength(2);
  });

  it('searches across text fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenders/search?q=road%20construction',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ externalId: string }> };
    expect(body.data.map((t) => t.externalId)).toEqual(['CIDB-T2']);
  });

  it('validates query parameters with the standard envelope', async () => {
    const headers = { 'x-api-key': API_KEY };
    const badLimit = await app.inject({ method: 'GET', url: '/api/v1/tenders?limit=101', headers });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const badStatus = await app.inject({ method: 'GET', url: '/api/v1/tenders?status=BOGUS', headers });
    expect(badStatus.statusCode).toBe(400);
    const badSort = await app.inject({ method: 'GET', url: '/api/v1/tenders?sort=rawHash', headers });
    expect(badSort.statusCode).toBe(400);
    const missingQ = await app.inject({ method: 'GET', url: '/api/v1/tenders/search', headers });
    expect(missingQ.statusCode).toBe(400);
  });
});

describe('tender detail and documents', () => {
  const headers = { 'x-api-key': API_KEY };

  it('returns full detail by id and by externalId, including documents', async () => {
    const byId = await app.inject({ method: 'GET', url: `/api/v1/tenders/${tenderIds.t1}`, headers });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({
      externalId: 'CIDB-T1',
      bidNumber: 'BID-T1',
      documents: [{ name: 'GET BID DOCUMENT', documentType: 'BID_DOCUMENT' }],
    });
    const byExternal = await app.inject({ method: 'GET', url: '/api/v1/tenders/CIDB-T1', headers });
    expect(byExternal.statusCode).toBe(200);
    expect((byExternal.json() as { id: string }).id).toBe(tenderIds.t1);
  });

  it('returns 404 for unknown tenders', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenders/does-not-exist', headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('lists tender documents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenders/CIDB-T1/documents', headers });
    expect(res.statusCode).toBe(200);
    const docs = res.json() as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ mimeType: 'application/pdf', downloadStatus: 'NOT_DOWNLOADED' });
    const empty = await app.inject({ method: 'GET', url: '/api/v1/tenders/CIDB-T2/documents', headers });
    expect((empty.json() as unknown[])).toHaveLength(0);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/tenders/nope/documents', headers });
    expect(missing.statusCode).toBe(404);
  });
});

describe('convenience filters', () => {
  const headers = { 'x-api-key': API_KEY };

  it('returns closing-soon tenders', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenders/closing-soon?days=7', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ externalId: string; status: string }> };
    expect(body.data.map((t) => t.externalId)).toEqual(['CIDB-T2']);
    expect(body.data[0].status).toBe('CLOSING_SOON');
  });

  it('filters by province, grade and class routes', async () => {
    const prov = await app.inject({ method: 'GET', url: '/api/v1/tenders/province/KwaZulu-Natal', headers });
    expect((prov.json() as { data: unknown[] }).data).toHaveLength(1);
    const grade = await app.inject({ method: 'GET', url: '/api/v1/tenders/grade/6', headers });
    // Exact "6" plus ranges containing 6 ("5-7").
    expect((grade.json() as { data: unknown[] }).data).toHaveLength(2);
    const klass = await app.inject({ method: 'GET', url: '/api/v1/tenders/class/gb', headers });
    expect((klass.json() as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe('stats', () => {
  it('returns aggregates and breakdowns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats', headers: { 'x-api-key': API_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      totalTenders: 4,
      openTenders: 2,
      closingSoon: 1,
      closedTenders: 1,
      byProvince: [
        { province: 'Gauteng', count: 2 },
        { province: 'KwaZulu-Natal', count: 1 },
        { province: 'Western Cape', count: 1 },
      ],
      byGrade: [
        { grade: '5-7', count: 1 },
        { grade: '6', count: 1 },
      ],
      byClass: [
        { class: 'CE', count: 2 },
        { class: 'GB', count: 1 },
      ],
    });
  });
});

describe('admin', () => {
  const adminHeaders = { 'x-api-key': ADMIN_KEY };

  it('forbids non-admin keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/sync',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(403);
  });

  it('starts a sync asynchronously and reports its lifecycle', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/admin/sync', headers: adminHeaders });
    expect(started.statusCode).toBe(202);
    const { syncId } = started.json() as { status: string; syncId: string };
    expect(syncId).toBeTruthy();

    const overlap = await app.inject({ method: 'POST', url: '/api/v1/admin/sync', headers: adminHeaders });
    // Either still running (409) or already finished in a networked env (202).
    expect([202, 409]).toContain(overlap.statusCode);

    const final = await pollSync(syncId);
    expect(['COMPLETED', 'PARTIAL', 'FAILED']).toContain(final.status as string);
    expect(final).toHaveProperty('recordsDiscovered');
    expect(final).toHaveProperty('recentErrors');

    const history = await app.inject({ method: 'GET', url: '/api/v1/admin/sync/history', headers: adminHeaders });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);

    const errors = await app.inject({ method: 'GET', url: '/api/v1/admin/errors', headers: adminHeaders });
    expect(errors.statusCode).toBe(200);
    expect(errors.json()).toHaveProperty('pagination');
  });

  it('returns 404 for unknown sync runs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sync/nope', headers: adminHeaders });
    expect(res.statusCode).toBe(404);
  });
});

describe('not found', () => {
  it('returns the standard envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: { 'x-api-key': API_KEY } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('api key usage', () => {
  it('stamps lastUsedAt on successful authentication', async () => {
    const key = await prisma.apiKey.findUnique({ where: { name: 'test-api' } });
    expect(key?.lastUsedAt).not.toBeNull();
  });
});
