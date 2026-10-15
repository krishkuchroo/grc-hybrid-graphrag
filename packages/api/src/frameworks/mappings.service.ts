// Control-to-requirement mappings (S2-005, D67, D212 (3)): a person records that a control
// satisfies a requirement, and takes it back if it was a mistake.
// - Adding: the control and the requirement must exist in the caller's org and be visible to them
//   (404 whichever it is, the same as a missing one), the caller must pass `canMapControl` (403:
//   only Admins and Compliance Managers, for a control at or below their clearance; owning the
//   control counts for nothing, D212 (3)), and the mapping must not be there yet (409
//   `link_exists`). The link and its `link.created` entry are saved in one Neo4j transaction
//   (D37, D45.4).
// - Removing: the same 404 and 403 checks, then the mapping must be there (404), and only a
//   `manual` or `import` mapping goes. An `ai` mapping is 409 `ai_link_review_only`: it is removed
//   only through the Analyst's review (D207, D16(b), D24). The deletion and its `link.removed`
//   entry are saved in one Neo4j transaction. A caller who fails the 404 or 403 check never learns
//   a mapping's origin.
// - Reads run as the caller's read-only role x clearance account (readAs), so Neo4j checks again
//   and hides every link with a hidden end (D45.3, D59). A read that must reach controls for a
//   role whose Control cell is "own" (the Control Owner) runs as the writer with
//   `owner = <caller>` in the query, as S1's links do. Every query also keeps to
//   `sensitivity IN <labels at or below the clearance>` (D51).
// - Log lines about a failed write hold only the error's type and code and the IDs (D163, D164).
import type { ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  LABELS,
  NODE_LABELS,
  ROLE_TABLE,
  can,
  canMapControl,
  isRecordVisible,
  isRemovableLinkOrigin,
  isVisible,
  type Label,
  type MappingLinkType,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../audit/outbox.js';
import { ApiError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import type { GraphService } from '../graph/graph.service.js';
import { linkRemovedAudit } from '../records/link-audit.js';
import { linkTargetId } from '../records/links.service.js';
import { visibleLabels } from '../records/record-queries.js';
import type { Caller } from '../records/records.service.js';

/** Neo4j stops a mappings read after this long (D48). */
export const MAPPING_READ_TIMEOUT_MS = 5000;

/** The one link type a person adds or removes here (D67). */
export const SATISFIES = 'SATISFIES' satisfies MappingLinkType;

const CONTROL = NODE_LABELS.control;
const REQUIREMENT = 'Requirement';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The body of POST /api/v1/mappings and /mappings/remove: two lowercase UUIDs, nothing else. */
export const mappingBodySchema = z.strictObject({
  controlId: z.string().regex(UUID, 'must be a lowercase UUID'),
  requirementId: z.string().regex(UUID, 'must be a lowercase UUID'),
});

export const mappingSchema = z.object({
  type: z.literal(SATISFIES),
  fromId: z.string(),
  toId: z.string(),
  origin: z.literal('manual'),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const removedMappingSchema = z.object({ type: z.literal(SATISFIES), fromId: z.string(), toId: z.string() });

export type MappingOut = z.infer<typeof mappingSchema>;
export type RemovedMapping = z.infer<typeof removedMappingSchema>;

export interface MappingsServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  log?: Logger;
}

/** The control end, as stored. */
interface ControlEnd {
  id: string;
  number: string;
  label: Label;
  owner: string;
}

/** The requirement end, as stored. */
interface RequirementEnd {
  id: string;
  number: string;
  label: Label;
}

/** A stored mapping, as read before removing it. */
interface FoundMapping {
  elementId: string;
  origin: unknown;
  createdAt: string;
  createdBy: string;
}

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');
const EXISTS = (): ApiError => new ApiError(409, 'link_exists', 'This mapping already exists.');
const AI_MAPPING = (): ApiError =>
  new ApiError(
    409,
    'ai_link_review_only',
    "This mapping was suggested by the AI. It can only be removed through the Analyst's review.",
  );

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

function toControl(p: Record<string, unknown>): ControlEnd {
  return {
    id: p['id'] as string,
    number: p['number'] as string,
    label: p['sensitivity'] as Label,
    owner: p['owner'] as string,
  };
}

function toRequirement(p: Record<string, unknown>): RequirementEnd {
  return { id: p['id'] as string, number: p['number'] as string, label: p['sensitivity'] as Label };
}

/** Our code's own check of the control (D50, D51), with ownership for the "own" cell. */
function controlVisibleTo(caller: Caller, control: ControlEnd): boolean {
  const viewer = { role: caller.role, clearance: caller.clearance };
  const isOwner = control.owner === caller.userId;
  return isRecordVisible(viewer, { recordType: 'control', label: control.label, isOwner });
}

/** Our code's own check of the requirement: the Framework-mappings `view` cell and the label. */
function requirementVisibleTo(caller: Caller, requirement: RequirementEnd): boolean {
  return can(caller.role, 'framework_mapping', 'view') && isVisible(caller.clearance, requirement.label);
}

/** The audit `meta` of a mapping entry: the two numbers and the higher of the two labels (D186). */
function metaOf(control: ControlEnd, requirement: RequirementEnd): OutboxAudit['meta'] {
  return {
    type: SATISFIES,
    fromNumber: control.number,
    toNumber: requirement.number,
    label: higher(control.label, requirement.label),
  };
}

/** The one SATISFIES link from the control to the requirement, if there is one. With `lock`, the
 * control is write-locked first (a property set and removed again, so the record is unchanged),
 * so two removals of the same mapping run one after the other and the second finds nothing. */
async function findMapping(
  tx: ManagedTransaction,
  controlId: string,
  requirementId: string,
  opts: { lock?: boolean } = {},
): Promise<FoundMapping | null> {
  if (opts.lock) {
    await tx.run(`MATCH (c:${CONTROL} {id: $id}) SET c.__lock = true REMOVE c.__lock`, { id: controlId });
  }
  const res = await tx.run(
    `MATCH (c:${CONTROL} {id: $controlId})-[r:${SATISFIES}]->(q:${REQUIREMENT} {id: $requirementId})
     RETURN elementId(r) AS rid, r.origin AS origin, r.createdAt AS createdAt, r.createdBy AS createdBy
     ORDER BY r.createdAt LIMIT 1`,
    { controlId, requirementId },
  );
  const row = res.records[0];
  if (!row) return null;
  return {
    elementId: row.get('rid') as string,
    origin: row.get('origin'),
    createdAt: row.get('createdAt') as string,
    createdBy: row.get('createdBy') as string,
  };
}

/** The only parts of an error a log line may hold (D163): its type and code, never its text. */
function errorFields(err: unknown): { errorType?: string; errorCode?: string } {
  if (typeof err !== 'object' || err === null) return {};
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  const fields: { errorType?: string; errorCode?: string } = {};
  const type = typeof e.name === 'string' && e.name !== 'Error' ? e.name : e.constructor?.name;
  if (typeof type === 'string' && type !== '') fields.errorType = type;
  if (typeof e.code === 'string') fields.errorCode = e.code;
  return fields;
}

/** An error without the failed write's details, for the caller (the log has the IDs). */
class MappingWriteFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The mapping could not be saved.');
    this.name = 'MappingWriteFailed';
  }
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

export class MappingsService {
  private readonly graph: MappingsServiceDeps['graph'];
  private readonly outbox: MappingsServiceDeps['outbox'];
  private readonly log: Logger;

  constructor(deps: MappingsServiceDeps) {
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.log = (deps.log ?? createLogger()).child({ context: 'MappingsService' });
  }

  /** Records that a control satisfies a requirement. The checks run in this order: both records
   * visible (404), `canMapControl` (403), the mapping not there yet (409 `link_exists`). The link
   * and its `link.created` entry are saved in one transaction, where the checks run again. */
  async create(caller: Caller, input: unknown): Promise<MappingOut> {
    const { controlId, requirementId } = mappingBodySchema.parse(input);
    const control = await this.findControl(caller, controlId);
    const requirement = await this.findRequirement(caller, requirementId);
    if (!control || !requirement) throw NOT_FOUND();
    if (!canMapControl(caller, control)) throw FORBIDDEN();

    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        // Read both ends again inside the write, so a change since the check above is seen.
        const c = await this.controlForWrite(tx, controlId);
        const q = await this.requirementForWrite(tx, requirementId);
        if (!c || !q || !controlVisibleTo(caller, c) || !requirementVisibleTo(caller, q)) throw NOT_FOUND();
        if (!canMapControl(caller, c)) throw FORBIDDEN();
        const link = await this.merge(tx, c, q, caller.userId);
        return {
          result: link,
          audit: {
            action: 'link.created',
            targetType: 'link',
            targetId: linkTargetId(SATISFIES, controlId, requirementId),
            before: null,
            after: { ...link },
            meta: metaOf(c, q),
          },
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const fields = errorFields(err);
      this.log.error({ orgId: caller.orgId, controlId, requirementId, ...fields }, 'mapping create failed');
      throw new MappingWriteFailed(fields.errorCode);
    }
  }

  /** Takes a mapping back (D207 applied to mappings). The checks run in this order: both records
   * visible (404), `canMapControl` (403), the mapping there (404), a removable origin (409). The
   * deletion and its `link.removed` entry are saved in one transaction, where the checks run
   * again. */
  async remove(caller: Caller, input: unknown): Promise<RemovedMapping> {
    const { controlId, requirementId } = mappingBodySchema.parse(input);
    const control = await this.findControl(caller, controlId);
    const requirement = await this.findRequirement(caller, requirementId);
    if (!control || !requirement) throw NOT_FOUND();
    if (!canMapControl(caller, control)) throw FORBIDDEN();
    const found = await this.read(caller, (tx) => findMapping(tx, controlId, requirementId));
    if (!found) throw NOT_FOUND();
    if (!isRemovableLinkOrigin(found.origin)) throw AI_MAPPING();

    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        const c = await this.controlForWrite(tx, controlId);
        const q = await this.requirementForWrite(tx, requirementId);
        if (!c || !q || !controlVisibleTo(caller, c) || !requirementVisibleTo(caller, q)) throw NOT_FOUND();
        if (!canMapControl(caller, c)) throw FORBIDDEN();
        const link = await findMapping(tx, controlId, requirementId, { lock: true });
        if (!link) throw NOT_FOUND();
        if (!isRemovableLinkOrigin(link.origin)) throw AI_MAPPING();
        const res = await tx.run(`MATCH ()-[r]->() WHERE elementId(r) = $rid DELETE r RETURN count(*) AS n`, {
          rid: link.elementId,
        });
        if (Number(res.records[0]?.get('n') ?? 0) !== 1) throw NOT_FOUND();
        const stored = {
          type: SATISFIES,
          fromId: controlId,
          toId: requirementId,
          createdAt: link.createdAt,
          createdBy: link.createdBy,
          origin: link.origin,
        };
        return {
          result: { type: SATISFIES, fromId: controlId, toId: requirementId },
          audit: linkRemovedAudit(stored, c, q),
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const fields = errorFields(err);
      this.log.error({ orgId: caller.orgId, controlId, requirementId, ...fields }, 'mapping remove failed');
      throw new MappingWriteFailed(fields.errorCode);
    }
  }

  /** The control by ID, if the caller can see it: a label at or below their clearance and, for
   * the "own" cell, their own (checked by Neo4j's account and by our query and code). */
  private async findControl(caller: Caller, id: string): Promise<ControlEnd | null> {
    const cell = ROLE_TABLE.control[caller.role];
    if (cell === 'none') return null;
    const own = cell === 'edit_own';
    const params: Record<string, unknown> = { id, visible: visibleLabels(caller.clearance) };
    if (own) params['self'] = caller.userId;
    const p = await this.read(caller, async (tx) => {
      const res = await tx.run(
        `MATCH (c:${CONTROL} {id: $id}) WHERE c.sensitivity IN $visible${own ? ' AND c.owner = $self' : ''}
         RETURN properties(c) AS p`,
        params,
      );
      return res.records[0]?.get('p') as Record<string, unknown> | undefined;
    });
    if (!p) return null;
    const control = toControl(p);
    return controlVisibleTo(caller, control) ? control : null;
  }

  /** The requirement by ID, if the caller can see it (every role may view the catalogs, up to
   * its clearance). This read always runs as the caller's read-only account. */
  private async findRequirement(caller: Caller, id: string): Promise<RequirementEnd | null> {
    if (!can(caller.role, 'framework_mapping', 'view')) return null;
    const p = await this.graph.readAs(
      caller.orgId,
      caller.role,
      caller.clearance,
      async (tx) => {
        const res = await tx.run(
          `MATCH (q:${REQUIREMENT} {id: $id}) WHERE q.sensitivity IN $visible RETURN properties(q) AS p`,
          { id, visible: visibleLabels(caller.clearance) },
        );
        return res.records[0]?.get('p') as Record<string, unknown> | undefined;
      },
      { timeoutMs: MAPPING_READ_TIMEOUT_MS },
    );
    if (!p) return null;
    const requirement = toRequirement(p);
    return requirementVisibleTo(caller, requirement) ? requirement : null;
  }

  private async controlForWrite(tx: ManagedTransaction, id: string): Promise<ControlEnd | null> {
    const res = await tx.run(`MATCH (c:${CONTROL} {id: $id}) RETURN properties(c) AS p`, { id });
    const p = res.records[0]?.get('p') as Record<string, unknown> | undefined;
    return p ? toControl(p) : null;
  }

  private async requirementForWrite(tx: ManagedTransaction, id: string): Promise<RequirementEnd | null> {
    const res = await tx.run(`MATCH (q:${REQUIREMENT} {id: $id}) RETURN properties(q) AS p`, { id });
    const p = res.records[0]?.get('p') as Record<string, unknown> | undefined;
    return p ? toRequirement(p) : null;
  }

  /** Adds the mapping unless one already joins the two records (409). MERGE locks both ends, so
   * two callers adding the same mapping at once get one link and one 409. Nothing else on either
   * node changes (same `version`, the control's Source note untouched, D212 (5)). */
  private async merge(
    tx: ManagedTransaction,
    control: ControlEnd,
    requirement: RequirementEnd,
    userId: string,
  ): Promise<MappingOut> {
    const token = `${Date.now()}-${Math.random()}`;
    const res = await tx.run(
      `MATCH (c:${CONTROL} {id: $controlId}), (q:${REQUIREMENT} {id: $requirementId})
       MERGE (c)-[r:${SATISFIES}]->(q)
       ON CREATE SET r.createdAt = $now, r.createdBy = $userId, r.origin = 'manual', r.__created = $token
       WITH r, coalesce(r.__created = $token, false) AS created
       REMOVE r.__created
       RETURN created, properties(r) AS p`,
      { controlId: control.id, requirementId: requirement.id, now: new Date().toISOString(), userId, token },
    );
    const row = res.records[0];
    if (!row || row.get('created') !== true) throw EXISTS();
    const p = row.get('p') as Record<string, unknown>;
    return {
      type: SATISFIES,
      fromId: control.id,
      toId: requirement.id,
      origin: 'manual',
      createdAt: p['createdAt'] as string,
      createdBy: p['createdBy'] as string,
    };
  }

  /** Runs a read that can reach controls: as the caller's read-only account, or as the writer when
   * the role's Control cell is "own" (no shared account can know who owns what). */
  private read<T>(caller: Caller, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    if (ROLE_TABLE.control[caller.role] === 'edit_own') return this.graph.read(caller.orgId, fn);
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, fn, { timeoutMs: MAPPING_READ_TIMEOUT_MS });
  }
}
