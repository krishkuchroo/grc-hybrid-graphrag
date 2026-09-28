// Machine API keys (D11, D54, D56): create, list, revoke, and look up the key a request presents.
//
// - A key is `grc_` plus 32 random bytes in base64url. Only its SHA-256 is stored, so the plain
//   key is shown once, in the create response, and can't be read back. The key is high-entropy
//   random, so a plain SHA-256 is enough to make it unrecoverable (no password-style stretching).
// - Each key has one org and one role, and a required expiry in the future. Revoking sets
//   `revoked_at`; rows are never deleted.
// - Create, revoke and each refused use of an expired or revoked key write an audit event in the
//   key's org. A key that matches nothing has no org, so its refusal goes to the API's own log.
// - Expiry reads the JavaScript clock, and every request reads the key's row again (no cache), so
//   a revoke or an expiry applies from the very next request.
import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { pageQuerySchema, type Paged } from '../common/paging.js';
import type { Db } from '../db/client.js';
import { ROLES, withOrgContext, type OrgContext, type Role } from '../db/org-context.js';
import { apiKeys } from './api-keys.schema.js';

export const KEY_PREFIX = 'grc_';
const KEY_BYTES = 32;
// `grc_` and the base64url of 32 bytes (43 characters).
const KEY_SHAPE = /^grc_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  expiresAt: z.iso
    .datetime({ offset: true })
    .refine((value) => new Date(value).getTime() > Date.now(), { message: 'must be in the future' }),
});

export type CreateKeyInput = z.infer<typeof createKeySchema>;

export const createdKeySchema = z.object({ id: z.string(), key: z.string() });

export const keyItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type KeyItem = z.infer<typeof keyItemSchema>;

export const keyListSchema = z.object({
  items: z.array(keyItemSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

/** Who a request with a valid key runs as (read by AccessGuard and later code). */
export interface KeyPrincipal {
  orgId: string;
  userId: string;
  role: Role;
  clearance: 'internal';
  apiKeyId: string;
}

export function hashKey(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

function unauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'The API key is not valid.');
}

export class ApiKeysService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: OrgContext, body: unknown): Promise<{ id: string; key: string }> {
    const input = createKeySchema.parse(body);
    const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
    const [row] = await withOrgContext(this.db, ctx, (tx) =>
      tx
        .insert(apiKeys)
        .values({
          orgId: ctx.orgId,
          name: input.name,
          role: input.role,
          keyHash: hashKey(key),
          expiresAt: new Date(input.expiresAt),
          createdBy: ctx.userId,
        })
        .returning({ id: apiKeys.id }),
    );
    if (!row) throw new Error('api key insert returned nothing');
    await this.audit.append({
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row.id,
      after: { name: input.name, role: input.role, expiresAt: new Date(input.expiresAt).toISOString() },
    });
    return { id: row.id, key };
  }

  async list(ctx: OrgContext, query: unknown): Promise<Paged<KeyItem>> {
    const { page, pageSize } = pageQuerySchema.parse(query ?? {});
    // Only the caller's own org, even where a grant would let RLS show another org's rows.
    const own = eq(apiKeys.orgId, ctx.orgId);
    return withOrgContext(this.db, ctx, async (tx) => {
      const [totalRow] = await tx.select({ n: count() }).from(apiKeys).where(own);
      const rows = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          role: apiKeys.role,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(own)
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role,
          expiresAt: r.expiresAt.toISOString(),
          revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
        page,
        pageSize,
        total: Number(totalRow?.n ?? 0),
      };
    });
  }

  /** Revokes a key of the caller's org. Another org's key and an unknown ID look the same: 404. */
  async revoke(ctx: OrgContext, id: string): Promise<void> {
    const notFound = new ApiError(404, 'not_found', 'Not found.');
    if (!UUID.test(id)) throw notFound;
    const outcome = await withOrgContext(this.db, ctx, async (tx) => {
      const mine = and(eq(apiKeys.id, id), eq(apiKeys.orgId, ctx.orgId));
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(mine, isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (revoked) return 'revoked' as const;
      const [exists] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(mine);
      return exists ? ('already' as const) : ('missing' as const);
    });
    if (outcome === 'missing') throw notFound;
    if (outcome === 'already') return;
    await this.audit.append({
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
    });
  }

  /**
   * The principal for a presented key, or a 401. An expired or revoked key writes
   * `api_key.refused` into its org's chain; a key that matches nothing is logged, without the key.
   */
  async authenticate(plain: string, log: FastifyBaseLogger): Promise<KeyPrincipal> {
    const found = KEY_SHAPE.test(plain) ? await this.findByHash(hashKey(plain)) : null;
    if (!found || !(ROLES as readonly string[]).includes(found.role)) {
      log.warn({ event: 'api_key.refused', reason: 'unknown' }, 'API key refused');
      throw unauthorized();
    }
    const reason = found.revoked_at ? 'revoked' : new Date(found.expires_at).getTime() <= Date.now() ? 'expired' : null;
    if (reason) {
      try {
        await this.audit.append({
          orgId: found.org_id,
          actorType: 'api_key',
          actorId: found.id,
          action: 'api_key.refused',
          targetType: 'api_key',
          targetId: found.id,
          meta: { reason },
        });
      } catch (err) {
        // Fail safe: the key stays refused even if the audit write fails.
        log.error({ err, event: 'api_key.refused', apiKeyId: found.id }, 'audit write failed');
      }
      throw unauthorized();
    }
    return {
      orgId: found.org_id,
      userId: `api_key:${found.id}`,
      role: found.role as Role,
      clearance: 'internal',
      apiKeyId: found.id,
    };
  }

  private async findByHash(hash: string): Promise<{
    id: string;
    org_id: string;
    role: string;
    expires_at: Date | string;
    revoked_at: Date | string | null;
  } | null> {
    const res = await this.db.execute<{
      id: string;
      org_id: string;
      role: string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
    }>(sql`SELECT id, org_id, role, expires_at, revoked_at FROM app_api_key_by_hash(${hash})`);
    return res.rows[0] ?? null;
  }
}
