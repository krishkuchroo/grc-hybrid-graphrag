// Shared set-up for the S1-011 link-removal tests (test writer's file, D89/D96).
//
// Decisions: D201 (removal: the same people who may add; the link and a copy in the audit trail,
// action `link.removed`), D207 (only `manual` and `import` links; `ai` is 409 `ai_link_review_only`),
// D200 (`canLinkRecords`), D51, D37, D45.4, D56, D186, D59, D69, D163, D164, D175, D176.
// The brief is TASKS.md "Task: S1-011", with the S1 shared notes and S1-005's brief.
//
// Contract these tests hold the code to:
// - `POST /api/v1/links/remove` with a strict body `{ type, fromId, toId }` (`type` one of the six
//   link types, the IDs lowercase UUIDs; anything else is 400 `validation_failed`). Any signed-in
//   caller may call it; the service decides, in this order:
//     1. both ends exist in the caller's org and are visible to them, and the link exists: else
//        404 `not_found`, the same answer for a missing end, a hidden end or no such link;
//     2. `canLinkRecords(caller, from, to)` (D200): else 403 `forbidden`;
//     3. the link's `origin` is `manual` or `import` (`isRemovableLinkOrigin`): else 409
//        `ai_link_review_only`, "This link was found by the AI. It can only be removed through the
//        Analyst's review." Nothing changes and no audit entry is written.
//   200 answers with `{ type, fromId, toId }`. The one relationship is deleted and a `link.removed`
//   entry (from `linkRemovedAudit`) is written in the same Neo4j transaction through
//   `AuditOutbox.withAuditedWrite`: `targetType: 'link'`, `targetId` = S1-005's `linkTargetId`,
//   `before` = `{ type, fromId, toId, fromNumber, toNumber, createdAt, createdBy, origin }`,
//   `after: null`, `meta { type, fromNumber, toNumber, label }` with the higher of the two labels.
//
// Throwaway data (D82, D176): each test file gets its own migrated Postgres database and its own
// `org-<uuid>` Neo4j databases (S1-005's links helpers), all dropped in afterAll. `import` and `ai`
// links, which no S1 route makes, are written straight into those throwaway org databases by the
// Desktop account; nothing shared is changed (no privilege, account or setting).
import 'reflect-metadata';
import { expect } from 'vitest';
import { LINK_TYPES, type LinkType } from '@grc/shared';
import { q } from '../auth/helpers.js';
import { createKey, useKey, type NewKey } from '../api-keys/helpers.js';
import { setting } from '../db/helpers.js';
import { runOn, superDriver } from '../graph/helpers.js';
import {
  LogCapture,
  platformDb,
  startApi,
  startWorker,
  waitFor,
  type InjectResponse,
  type WorkerApp,
} from '../platform/helpers.js';
import { call, kit } from '../auth/helpers.js';
import { answered, json, show, tearDownLinks, type LinksEnv, type Person } from '../links/helpers.js';

export * from '../links/helpers.js';
export { createKey, useKey, waitFor, type NewKey };

export const REMOVE = '/api/v1/links/remove';
export const AI_MESSAGE = "This link was found by the AI. It can only be removed through the Analyst's review.";
export const GHOST = '00000000-0000-4000-8000-00000000d201';

export type Origin = 'manual' | 'import' | 'ai';

export interface RemovalEnv extends LinksEnv {
  worker?: WorkerApp;
}

/** S1-005's links environment, plus the worker (its outbox relay) when asked. */
export async function setUpRemoval(opts: { worker?: boolean } = {}): Promise<RemovalEnv> {
  const db = await platformDb();
  const logs = new LogCapture();
  process.env.NEO4J_QUERY_SECRET ||= setting('NEO4J_QUERY_SECRET');
  let app;
  let worker: WorkerApp | undefined;
  try {
    app = await startApi({ logStream: logs });
    if (opts.worker) worker = await startWorker();
  } catch (err) {
    await app?.close().catch(() => undefined);
    await db.drop();
    throw err;
  }
  return { db, app, k: kit(db), sup: superDriver(), databases: new Set(), logs, worker };
}

export async function tearDownRemoval(env: RemovalEnv | undefined): Promise<void> {
  if (!env) return;
  await env.worker?.close().catch(() => undefined);
  await tearDownLinks(env);
}

// ---------- the route ----------

export async function removeLink(env: LinksEnv, who: Person, body: unknown): Promise<InjectResponse> {
  return call(env.app, who.signedIn.jar, { method: 'POST', url: REMOVE, payload: body });
}

export async function removeWithKey(env: LinksEnv, key: NewKey, body: unknown): Promise<InjectResponse> {
  return useKey(env.app, key, { method: 'POST', url: REMOVE, payload: body });
}

export function body(
  type: string,
  from: { id: string },
  to: { id: string },
): { type: string; fromId: string; toId: string } {
  return { type, fromId: from.id, toId: to.id };
}

/** The 200 answer: the removed link `{ type, fromId, toId }`. */
export function removed(res: InjectResponse, want: { type: string; fromId: string; toId: string }): void {
  expect(answered(res), show(res)).toBe(200);
  expect(json(res)).toMatchObject(want);
}

// ---------- links written straight into the throwaway org database ----------

export interface SeededLink {
  type: string;
  fromId: string;
  toId: string;
  origin: Origin;
  createdAt: string;
  createdBy: string;
}

/**
 * A link with the given origin, written by the Desktop account into the throwaway org database.
 * `ai` links also carry the S4 provenance fields (S1 shared notes), so they look like real ones.
 */
export async function seedLink(
  env: LinksEnv,
  orgId: string,
  type: string,
  from: { id: string },
  to: { id: string },
  opts: { origin?: Origin; createdBy?: string; createdAt?: string } = {},
): Promise<SeededLink> {
  const origin = opts.origin ?? 'manual';
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const createdBy = opts.createdBy ?? 'test-seed';
  const extra =
    origin === 'ai'
      ? ", sourceDocId: 'doc-test', chunkId: 'chunk-test', sentence: 'test sentence', model: 'gemma4:12b', promptVersion: 'test'"
      : '';
  const done = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (a {id: $fromId}), (b {id: $toId})
     CREATE (a)-[r:\`${type}\` {createdAt: $createdAt, createdBy: $createdBy, origin: $origin${extra}}]->(b)
     RETURN count(r) AS n`,
    { fromId: from.id, toId: to.id, createdAt, createdBy, origin },
  );
  if (Number(done[0]?.['n'] ?? 0) !== 1) throw new Error(`seedLink: ${type} not written (an end is missing)`);
  return { type, fromId: from.id, toId: to.id, origin, createdAt, createdBy };
}

/** How many `type` relationships go from `fromId` to `toId`. */
export async function linkCount(
  env: LinksEnv,
  orgId: string,
  type: string,
  fromId: string,
  toId: string,
): Promise<number> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (a {id: $fromId})-[r]->(b {id: $toId}) WHERE type(r) = $type RETURN count(r) AS n`,
    { fromId, toId, type },
  );
  return Number(found[0]?.['n'] ?? 0);
}

/** A record's stored properties (every field, `version` included), for "unchanged" checks. */
export async function nodeProps(env: LinksEnv, orgId: string, id: string): Promise<Record<string, unknown>> {
  const found = await runOn(env.sup, `org-${orgId}`, 'MATCH (n {id: $id}) RETURN properties(n) AS p', { id });
  const p = found[0]?.['p'] as Record<string, unknown> | undefined;
  if (!p) throw new Error(`no node ${id}`);
  return p;
}

/** Which link types pair which kinds (the ontology, S1-001's LINK_TYPES). */
export const LINK_ROWS = LINK_TYPES.map((row) => ({ type: row.type as LinkType, from: row.from, to: row.to }));

/** S1-005's `linkTargetId` rule, read from the merged service so the two entries pair up. */
export async function targetIdOf(type: string, fromId: string, toId: string): Promise<string> {
  const mod = (await import('../../src/records/links.service.js')) as {
    linkTargetId: (type: string, fromId: string, toId: string) => string;
  };
  return mod.linkTargetId(type, fromId, toId);
}

// ---------- the Postgres audit trail (with the worker's relay) ----------

export interface AuditRow {
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
}

export function auditRows(env: LinksEnv, orgId: string, action?: string): Promise<AuditRow[]> {
  return q<AuditRow>(
    env.k,
    `SELECT action, actor_type, actor_id, target_type, target_id, before, after, meta
     FROM audit_events WHERE org_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY seq`,
    [orgId, action ?? null],
  );
}

/** Waits (up to 5 s, D48) until the Postgres audit trail holds an entry for this target. */
export async function relayed(env: LinksEnv, orgId: string, action: string, targetId: string): Promise<AuditRow> {
  return waitFor(
    `${action} ${targetId} in the Postgres audit trail`,
    async () => (await auditRows(env, orgId, action)).find((r) => r.target_id === targetId),
    5000,
  );
}
