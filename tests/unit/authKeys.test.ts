import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncEnvKeysToDatabase } from '../../src/auth/apiKey.js';
import { config } from '../../src/config.js';
import { createMemoryDb } from '../../src/database/memory.js';
import { DbClient } from '../../src/database/types.js';
import { hashApiKey } from '../../src/utils/hashing.js';

const originalApiKey = config.API_KEY;
const originalAdminKey = config.ADMIN_API_KEY;
let db: DbClient;

beforeEach(() => {
  db = createMemoryDb().db;
  config.API_KEY = '';
  config.ADMIN_API_KEY = '';
});

afterEach(() => {
  config.API_KEY = originalApiKey;
  config.ADMIN_API_KEY = originalAdminKey;
});

describe('syncEnvKeysToDatabase', () => {
  it('seeds both keys hashed with correct roles', async () => {
    config.API_KEY = 'api-secret';
    config.ADMIN_API_KEY = 'admin-secret';
    await syncEnvKeysToDatabase(db);

    const api = await db.apiKey.findUnique({ where: { name: 'env-default' } });
    const admin = await db.apiKey.findUnique({ where: { name: 'env-admin' } });
    expect(api).toMatchObject({ role: 'API', active: true, keyHash: hashApiKey('api-secret') });
    expect(admin).toMatchObject({ role: 'ADMIN', active: true, keyHash: hashApiKey('admin-secret') });
    expect(api?.keyHash).not.toContain('api-secret');
  });

  it('is idempotent across restarts', async () => {
    config.API_KEY = 'api-secret';
    config.ADMIN_API_KEY = 'admin-secret';
    await syncEnvKeysToDatabase(db);
    await syncEnvKeysToDatabase(db);
    const api = await db.apiKey.findUnique({ where: { name: 'env-default' } });
    expect(api?.keyHash).toBe(hashApiKey('api-secret'));
  });

  it('rotates a changed secret', async () => {
    config.API_KEY = 'old-secret';
    await syncEnvKeysToDatabase(db);
    config.API_KEY = 'new-secret';
    await syncEnvKeysToDatabase(db);
    const api = await db.apiKey.findUnique({ where: { name: 'env-default' } });
    expect(api?.keyHash).toBe(hashApiKey('new-secret'));
  });

  it('skips the admin seed when both secrets are identical', async () => {
    config.API_KEY = 'same-secret';
    config.ADMIN_API_KEY = 'same-secret';
    await syncEnvKeysToDatabase(db);
    expect(await db.apiKey.findUnique({ where: { name: 'env-default' } })).not.toBeNull();
    expect(await db.apiKey.findUnique({ where: { name: 'env-admin' } })).toBeNull();
  });

  it('blocks rotation when another row holds the new hash (keeps old key working)', async () => {
    config.API_KEY = 'first-secret';
    await syncEnvKeysToDatabase(db);
    // Simulate a conflicting row (e.g. secrets were swapped between roles).
    await db.apiKey.create({ data: { name: 'other', keyHash: hashApiKey('second-secret'), role: 'API' } });
    config.API_KEY = 'second-secret';
    await syncEnvKeysToDatabase(db);
    const api = await db.apiKey.findUnique({ where: { name: 'env-default' } });
    expect(api?.keyHash).toBe(hashApiKey('first-secret'));
  });

  it('creates nothing when no secrets are configured', async () => {
    await syncEnvKeysToDatabase(db);
    expect(await db.apiKey.findUnique({ where: { name: 'env-default' } })).toBeNull();
  });
});
