// The audit trail service (D37, D56, D73). Appends events to an org's hash chain and checks the
// chain. It runs as grc_app (the database it is given) and sets the org context for each call
// itself, so the org wall applies to every read and write.
//
// Appends for one org are serialised with a transaction-scoped advisory lock on the org, so
// concurrent appends get seq 1, 2, 3 … with no gaps and no forks. `sourceId` is unique per org:
// a repeat append with the same sourceId stores nothing and returns the first entry.
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Tx } from '../db/org-context.js';
import { auditEvents } from './audit.schema.js';
import { GENESIS_HASH, hashEntry } from './chain.js';

export interface AuditEventInput {
  orgId: string;
  actorType: 'user' | 'api_key' | 'system';
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  sourceId?: string;
}

export type VerifyResult = { ok: true } | { ok: false; brokenAtSeq: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkOrgId(orgId: string): void {
  if (typeof orgId !== 'string' || !UUID.test(orgId)) throw new Error('audit: orgId must be a UUID');
}

// JSON values as they come back from jsonb (undefined dropped, dates as strings), or null.
function json(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

interface Row {
  orgId: string;
  seq: number;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  sourceId: string | null;
  createdAt: Date;
}

// What the hash covers: every field of the event except the hashes themselves.
function hashed(r: Row): object {
  return {
    orgId: r.orgId,
    seq: r.seq,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    before: r.before,
    after: r.after,
    meta: r.meta,
    sourceId: r.sourceId,
    createdAt: r.createdAt.toISOString(),
  };
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async append(e: AuditEventInput): Promise<{ seq: number; hash: string }> {
    return this.inOrg(e.orgId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'audit:' + e.orgId}, 0))`);
      if (e.sourceId !== undefined) {
        const [seen] = await tx
          .select({ seq: auditEvents.seq, hash: auditEvents.hash })
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, e.orgId), eq(auditEvents.sourceId, e.sourceId)));
        if (seen) return { seq: Number(seen.seq), hash: seen.hash };
      }
      const [last] = await tx
        .select({ seq: auditEvents.seq, hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.orgId, e.orgId))
        .orderBy(desc(auditEvents.seq))
        .limit(1);
      const prevHash = last?.hash ?? GENESIS_HASH;
      const row: Row = {
        orgId: e.orgId,
        seq: last ? Number(last.seq) + 1 : 1,
        actorType: e.actorType,
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        before: json(e.before),
        after: json(e.after),
        meta: json(e.meta),
        sourceId: e.sourceId ?? null,
        createdAt: new Date(),
      };
      const hash = hashEntry(prevHash, hashed(row));
      await tx.insert(auditEvents).values({ ...row, prevHash, hash });
      return { seq: row.seq, hash };
    });
  }

  async verifyChain(orgId: string): Promise<VerifyResult> {
    return this.inOrg(orgId, async (tx) => {
      const found = await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.orgId, orgId))
        .orderBy(asc(auditEvents.seq));
      let prevHash = GENESIS_HASH;
      let expectedSeq = 1;
      for (const r of found) {
        const seq = Number(r.seq);
        if (seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq };
        if (r.prevHash !== prevHash) return { ok: false, brokenAtSeq: seq };
        if (hashEntry(r.prevHash, hashed({ ...r, seq })) !== r.hash) return { ok: false, brokenAtSeq: seq };
        prevHash = r.hash;
        expectedSeq++;
      }
      return { ok: true };
    });
  }

  /** The orgs that have an audit partition, read from the catalog (the nightly check's list). */
  async orgIds(): Promise<string[]> {
    const res = await this.db.execute<{ org: string | null }>(sql`
      SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid),
              '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'))[1] AS org
      FROM pg_catalog.pg_inherits i
      JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.audit_events'::regclass
      ORDER BY 1`);
    return res.rows.map((r) => r.org).filter((o): o is string => typeof o === 'string');
  }

  // One transaction with only app.org_id set (SET LOCAL), so RLS limits it to this org.
  private inOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    checkOrgId(orgId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
      return fn(tx);
    });
  }
}

/**
 * Creates the org's audit partition, with RLS forced and the add-only trigger. Safe to call
 * again. Run by org provisioning (M0-014) as the platform operator (the table's owner).
 */
export async function createAuditPartition(db: Db, orgId: string): Promise<void> {
  checkOrgId(orgId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT public.audit_create_partition(${orgId}::uuid)`);
  });
}
