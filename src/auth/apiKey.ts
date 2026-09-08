import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { DbClient, prisma } from '../database/client.js';
import { ApiKeyRole } from '../database/types.js';
import { hashApiKey, safeEqualHex } from '../utils/hashing.js';
import { logger } from '../utils/logging.js';

export interface AuthenticatedKey {
  id: string;
  name: string;
  role: ApiKeyRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: AuthenticatedKey;
  }
}

export function sendUnauthorized(reply: FastifyReply, message = 'Missing or invalid API key'): FastifyReply {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message } });
}

export function sendForbidden(reply: FastifyReply, message = 'Admin privileges required'): FastifyReply {
  return reply.status(403).send({ error: { code: 'FORBIDDEN', message } });
}

function extractKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

async function verifyAgainstDatabase(db: DbClient, plaintext: string): Promise<AuthenticatedKey | null> {
  const keyHash = hashApiKey(plaintext);
  // Fetch candidates by hash prefix would leak timing less, but a direct
  // unique lookup + constant-time compare is simple and safe here.
  const record = await db.apiKey.findUnique({ where: { keyHash } });
  if (!record || !record.active) return null;
  if (!safeEqualHex(record.keyHash, keyHash)) return null;
  // Fire-and-forget usage stamp (never blocks the request).
  void db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch((error) => {
    logger.warn({ event: 'API_KEY_STAMP_FAILED', error: (error as Error).message }, 'Failed to stamp API key usage');
  });
  return { id: record.id, name: record.name, role: record.role };
}

/**
 * Bootstrap DB-backed keys from environment secrets. The plaintext env
 * values are hashed (SHA-256, domain-separated) before storage — the DB
 * never holds a usable secret.
 */
export async function syncEnvKeysToDatabase(db: DbClient = prisma): Promise<void> {
  const seeds: Array<{ name: string; plaintext: string; role: ApiKeyRole }> = [];
  if (config.API_KEY) seeds.push({ name: 'env-default', plaintext: config.API_KEY, role: 'API' });
  if (config.ADMIN_API_KEY) {
    if (config.ADMIN_API_KEY === config.API_KEY) {
      // Both env vars hold the same secret: the two rows would collide on the
      // unique keyHash. Seed the API key only and tell the operator to fix it.
      logger.error(
        { event: 'API_KEY_IDENTICAL' },
        'API_KEY and ADMIN_API_KEY are identical — generate two different secrets. ' +
          'Admin endpoints will reject requests until ADMIN_API_KEY is unique.',
      );
    } else {
      seeds.push({ name: 'env-admin', plaintext: config.ADMIN_API_KEY, role: 'ADMIN' });
    }
  }

  for (const seed of seeds) {
    try {
      const keyHash = hashApiKey(seed.plaintext);
      const existingByName = await db.apiKey.findUnique({ where: { name: seed.name } });
      if (existingByName && existingByName.keyHash !== keyHash) {
        // Secret rotated: replace hash, keep identity — unless another row
        // already holds the new hash (e.g. swapped secrets), which would
        // violate the unique constraint. Never crash the boot for this.
        const clash = await db.apiKey.findUnique({ where: { keyHash } });
        if (clash && clash.id !== existingByName.id) {
          logger.warn(
            { event: 'API_KEY_ROTATION_BLOCKED', name: seed.name, clashName: clash.name },
            `Rotation of '${seed.name}' blocked: its new hash is already registered as '${clash.name}'. ` +
              `The previous key stays active. To fix, delete the stale row ` +
              `(DELETE FROM "ApiKey" WHERE name = '${seed.name}') and redeploy.`,
          );
          continue;
        }
        await db.apiKey.update({
          where: { name: seed.name },
          data: { keyHash, role: seed.role, active: true },
        });
        logger.info({ event: 'API_KEY_ROTATED', name: seed.name }, 'Environment API key rotated in database');
        continue;
      }
      if (!existingByName) {
        const clashing = await db.apiKey.findUnique({ where: { keyHash } });
        if (clashing) {
          logger.warn(
            { event: 'API_KEY_SEED_SKIPPED', name: seed.name },
            'Environment key hash already registered under a different name; skipping seed',
          );
          continue;
        }
        await db.apiKey.create({ data: { name: seed.name, keyHash, role: seed.role, active: true } });
        logger.info({ event: 'API_KEY_SEEDED', name: seed.name }, 'Environment API key registered in database');
      }
    } catch (error) {
      logger.error(
        { event: 'API_KEY_SEED_FAILED', name: seed.name, error: (error as Error).message },
        'Failed to seed environment API key; existing keys (if any) keep working',
      );
    }
  }

  if (seeds.length === 0) {
    logger.warn(
      { event: 'API_KEY_MISSING' },
      'Neither API_KEY nor ADMIN_API_KEY is set — all authenticated endpoints will reject requests',
    );
  }
}

/** Authenticate any active key (API or ADMIN role). */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const plaintext = extractKey(request);
  if (!plaintext) {
    sendUnauthorized(reply);
    return;
  }
  const key = await verifyAgainstDatabase(prisma, plaintext);
  if (!key) {
    sendUnauthorized(reply);
    return;
  }
  request.apiKey = key;
}

/** Authenticate an ADMIN-role key. */
export async function requireAdminKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const plaintext = extractKey(request);
  if (!plaintext) {
    sendUnauthorized(reply);
    return;
  }
  const key = await verifyAgainstDatabase(prisma, plaintext);
  if (!key) {
    sendUnauthorized(reply);
    return;
  }
  if (key.role !== 'ADMIN') {
    sendForbidden(reply);
    return;
  }
  request.apiKey = key;
}
