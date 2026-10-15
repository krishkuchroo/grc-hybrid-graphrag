// Audit findings (S3-010, D202, D213 (1), (2)): what an audit found, how serious it is, when it's
// due, and the controls and risks it concerns (CONCERNS, D67).
// - Our code checks the org, the D50 role table (the Auditor edits; Admin, Risk Manager,
//   Compliance Manager, Control Owner and Analyst view; the Viewer sees none) and the D51 label
//   first (D45.3, D59). Finding reads then run as the caller's read-only role x clearance account
//   (readAs), so Neo4j checks again. A read that reaches controls for a role whose Control cell is
//   "own" (the Control Owner) runs as the writer with `owner = <caller>` in the query, as S1 does.
// - A finding is created with the control or risk it concerns (R11): the node, its CONCERNS link
//   and one `record.created` entry are saved in one Neo4j transaction (D37, D45.4), and its last
//   CONCERNS link can't be removed (409 `last_concern`, counting links the caller can't see).
// - Dates (R15): S3-002's schemas check a request on its own, with today's date; an update is
//   checked again after it's merged into the stored finding (`findingDateProblems`).
// - Links follow D200, D201 and D207: `canLinkFinding` to add or remove one, and an `ai` link is
//   removed only through the Analyst (409 `ai_link_review_only`). A caller who fails the 404 or
//   403 check never learns a link's origin.
// - Stale saves are refused (D69), findings are retired, never deleted, and numbers come from the
//   per-org `audit_finding` counter (D68, D213 (1)).
// - Log lines about a failed write hold only the error's type and code and the IDs (D163, D164).
import { randomUUID } from 'node:crypto';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  LABELS,
  NODE_LABELS,
  ROLE_TABLE,
  auditFindingRecordSchema,
  canAddFinding,
  canChangeLabel,
  canLinkFinding,
  defaultLabel,
  findingDateMessage,
  findingDateProblems,
  intakeCreateSchemasOn,
  intakeUpdateSchemasOn,
  isRecordVisible,
  isRemovableLinkOrigin,
  isVisible,
  type AuditFindingRecord,
  type Label,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import { ApiError } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import type { GraphService } from '../../graph/graph.service.js';
import { linkRemovedAudit } from '../../records/link-audit.js';
import { linkTargetId } from '../../records/links.service.js';
import { isOrgMember } from '../../records/owners.js';
import { NUMBER_CLASH_ATTEMPTS, isNumberClash } from '../../records/record-numbers.js';
import type { Caller } from '../../records/records.service.js';
import { takeFindingNumber } from './finding-numbers.js';
import {
  CONCERNS,
  CONCERN_KINDS,
  concernCountQuery,
  concernForWriteQuery,
  concernScope,
  concernTargetQuery,
  concerningFindingsQuery,
  concernsOfQuery,
  createFindingQuery,
  deleteLinkQuery,
  findConcernQuery,
  findingForWriteQuery,
  findingGetQuery,
  findingListQueries,
  lockFindingQuery,
  mergeConcernQuery,
  parseConcernedFindingsQuery,
  parseFindingListQuery,
  readsAsWriter,
  saveFindingQuery,
  utcToday,
  type BuiltQuery,
  type ConcernKind,
} from './finding-queries.js';

/** Neo4j stops a findings read after this long (D48). */
export const FINDING_READ_TIMEOUT_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The body of POST /api/v1/audit-findings/:id/concerns and …/concerns/remove. */
export const concernBodySchema = z.strictObject({ toId: z.string().regex(UUID, 'must be a lowercase UUID') });

/** A control or risk a finding concerns, with the link. */
export const concernItemSchema = z.object({
  kind: z.enum(CONCERN_KINDS),
  id: z.string(),
  number: z.string(),
  name: z.string(),
  label: z.enum(LABELS),
  status: z.string(),
  origin: z.enum(['manual', 'import', 'ai']),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const concernListSchema = z.object({ items: z.array(concernItemSchema) });

/** A CONCERNS link as added. */
export const concernLinkSchema = z.object({
  type: z.literal(CONCERNS),
  fromId: z.string(),
  toId: z.string(),
  origin: z.literal('manual'),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const removedConcernSchema = z.object({ type: z.literal(CONCERNS), fromId: z.string(), toId: z.string() });

export const findingListSchema = z.object({ items: z.array(auditFindingRecordSchema) });

export const pagedFindingsSchema = z.object({
  items: z.array(auditFindingRecordSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

export type ConcernItem = z.infer<typeof concernItemSchema>;
export type ConcernLink = z.infer<typeof concernLinkSchema>;
export type RemovedConcern = z.infer<typeof removedConcernSchema>;

export interface FindingsServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  db: Db;
  log?: Logger;
  /** Today's date as `YYYY-MM-DD`, for the date rules and the `due` filters (UTC by default). */
  today?: () => string;
}

/** A control or risk, as stored. */
interface ConcernEnd {
  id: string;
  kind: ConcernKind;
  number: string;
  label: Label;
  owner: string;
}

/** A finding, as stored: what the link rules and audit entries need. */
interface FindingEnd {
  id: string;
  number: string;
  label: Label;
  owner: string;
}

const STALE_MESSAGE = 'This record changed since you opened it. Reload it and try again.';
const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');
const LABEL_FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not set this label.');
const BAD_OWNER = (): ApiError =>
  new ApiError(400, 'validation_failed', 'owner: must be a member of this organization.');
const LINK_EXISTS = (): ApiError => new ApiError(409, 'link_exists', 'This link already exists.');
const LAST_CONCERN = (): ApiError =>
  new ApiError(409, 'last_concern', 'A finding must concern at least one control or risk.');
const AI_LINK = (): ApiError =>
  new ApiError(
    409,
    'ai_link_review_only',
    "This link was found by the AI. It can only be removed through the Analyst's review.",
  );

const KIND_BY_LABEL: ReadonlyMap<string, ConcernKind> = new Map(
  CONCERN_KINDS.map((kind) => [NODE_LABELS[kind], kind] as const),
);

function kindOf(labels: unknown): ConcernKind | undefined {
  if (!Array.isArray(labels)) return undefined;
  for (const l of labels) {
    const kind = KIND_BY_LABEL.get(String(l));
    if (kind) return kind;
  }
  return undefined;
}

/** Integers go to Neo4j as integers, not floats. */
function toNeo(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === 'number' && Number.isInteger(v) ? neo4j.int(v) : v]),
  );
}

/** A stored finding as the API returns it (the label as `label`; a missing closed date or
 * description as `null`). */
function toOut(p: Record<string, unknown>): AuditFindingRecord {
  return {
    id: p['id'] as string,
    number: p['number'] as string,
    sourceIds: (p['sourceIds'] as string[] | undefined) ?? [],
    name: p['name'] as string,
    label: p['sensitivity'] as Label,
    status: p['status'] as AuditFindingRecord['status'],
    owner: p['owner'] as string,
    version: Number(p['version']),
    createdAt: p['createdAt'] as string,
    createdBy: p['createdBy'] as string,
    updatedAt: p['updatedAt'] as string,
    updatedBy: p['updatedBy'] as string,
    origin: p['origin'] as AuditFindingRecord['origin'],
    severity: p['severity'] as AuditFindingRecord['severity'],
    findingStatus: p['findingStatus'] as AuditFindingRecord['findingStatus'],
    sourceReference: (p['sourceReference'] as string | undefined) ?? '',
    rootCause: (p['rootCause'] as string | undefined) ?? '',
    remediationPlan: (p['remediationPlan'] as string | undefined) ?? '',
    identifiedDate: p['identifiedDate'] as string,
    dueDate: p['dueDate'] as string,
    closedDate: (p['closedDate'] as string | undefined) ?? null,
    description: (p['description'] as string | undefined) ?? null,
  };
}

function toFindingEnd(p: Record<string, unknown>): FindingEnd {
  return {
    id: p['id'] as string,
    number: p['number'] as string,
    label: p['sensitivity'] as Label,
    owner: p['owner'] as string,
  };
}

function toConcernEnd(kind: ConcernKind, p: Record<string, unknown>): ConcernEnd {
  return {
    id: p['id'] as string,
    kind,
    number: p['number'] as string,
    label: p['sensitivity'] as Label,
    owner: p['owner'] as string,
  };
}

/** The API's name for a stored property (`sensitivity` is `label`). */
function apiName(prop: string): string {
  return prop === 'sensitivity' ? 'label' : prop;
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

/** Our code's own check of a finding (D50, D51): the role views findings and sees the label. */
function findingVisibleTo(caller: Caller, finding: { label: unknown }): boolean {
  return ROLE_TABLE.audit_finding[caller.role] !== 'none' && isVisible(caller.clearance, String(finding.label));
}

/** Our code's own check of a control or risk (D50, D51), with ownership for the "own" cell. */
function concernVisibleTo(caller: Caller, end: ConcernEnd): boolean {
  const viewer = { role: caller.role, clearance: caller.clearance };
  return isRecordVisible(viewer, { recordType: end.kind, label: end.label, isOwner: end.owner === caller.userId });
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
class FindingWriteFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The audit finding could not be saved.');
    this.name = 'FindingWriteFailed';
  }
}

async function run(tx: ManagedTransaction, q: BuiltQuery) {
  return tx.run(q.text, q.params);
}

async function rows(tx: ManagedTransaction, q: BuiltQuery): Promise<Record<string, unknown>[]> {
  const res = await run(tx, q);
  return res.records.map((r) => r.get('p') as Record<string, unknown>);
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

export class FindingsService {
  private readonly graph: FindingsServiceDeps['graph'];
  private readonly outbox: FindingsServiceDeps['outbox'];
  private readonly db: Db;
  private readonly log: Logger;
  private readonly today: () => string;

  constructor(deps: FindingsServiceDeps) {
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.db = deps.db;
    this.log = (deps.log ?? createLogger()).child({ context: 'FindingsService' });
    this.today = deps.today ?? (() => utcToday());
  }

  /** Creates a finding with the control or risk it concerns (R11). The checks run in this order:
   * the body (400), `canAddFinding` (403), the label (403, D198), the owner (400), the concerned
   * record visible (404), `canLinkFinding` (403). */
  async create(caller: Caller, input: unknown): Promise<AuditFindingRecord> {
    const body = intakeCreateSchemasOn(this.today()).audit_finding.parse(input);
    if (!canAddFinding(caller)) throw FORBIDDEN();
    const label = body.label ?? defaultLabel('audit_finding');
    if (!isVisible(caller.clearance, label)) throw LABEL_FORBIDDEN(); // D198
    if (body.owner === undefined && caller.apiKeyId !== undefined) {
      throw new ApiError(400, 'validation_failed', 'owner: an API key must name an owner.');
    }
    if (body.owner !== undefined && !(await isOrgMember(this.db, caller, body.owner))) throw BAD_OWNER();
    const owner = body.owner ?? caller.userId;
    const target = await this.findConcernTarget(caller, body.concernsId);
    if (!target) throw NOT_FOUND();
    if (!canLinkFinding(caller, { label, owner }, target)) throw FORBIDDEN();

    const fields: Record<string, unknown> = {
      name: body.name,
      severity: body.severity,
      findingStatus: body.findingStatus,
      sourceReference: body.sourceReference,
      rootCause: body.rootCause,
      remediationPlan: body.remediationPlan,
      identifiedDate: body.identifiedDate,
      dueDate: body.dueDate,
      closedDate: body.closedDate ?? null,
      description: body.description ?? null,
    };
    const stored = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    for (let attempt = 1; ; attempt += 1) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const props = {
        id,
        sourceIds: [],
        ...stored,
        sensitivity: label,
        status: 'active',
        owner,
        version: 1,
        createdAt: now,
        createdBy: caller.userId,
        updatedAt: now,
        updatedBy: caller.userId,
        origin: 'manual',
      };
      try {
        return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
          // Read the concerned record again inside the write, so a change since the check is seen.
          const [p] = await rows(tx, concernForWriteQuery(target.kind, target.id));
          const end = p ? toConcernEnd(target.kind, p) : null;
          if (!end || !concernVisibleTo(caller, end)) throw NOT_FOUND();
          if (!canLinkFinding(caller, { label, owner }, end)) throw FORBIDDEN();
          const number = await takeFindingNumber(tx);
          const link = { createdAt: now, createdBy: caller.userId };
          const [saved] = await rows(tx, createFindingQuery(end.kind, end.id, toNeo({ ...props, number }), link));
          if (!saved) throw NOT_FOUND();
          const out = toOut(saved);
          const after = { ...fields, label, owner, status: 'active', concerns: end.id };
          return { result: out, audit: this.entry('record.created', out, null, after, label) };
        });
      } catch (err) {
        if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
        throw this.failed(err, 'finding create failed', { orgId: caller.orgId, findingId: id });
      }
    }
  }

  async get(caller: Caller, id: string): Promise<AuditFindingRecord> {
    const found = await this.findFindingProps(caller, id);
    if (!found) throw NOT_FOUND();
    return toOut(found);
  }

  async list(caller: Caller, query: unknown): Promise<Paged<AuditFindingRecord>> {
    const q = parseFindingListQuery(query);
    if (ROLE_TABLE.audit_finding[caller.role] === 'none') throw FORBIDDEN();
    const built = findingListQueries(q, { clearance: caller.clearance }, this.today());
    return this.graph.readAs(
      caller.orgId,
      caller.role,
      caller.clearance,
      async (tx) => {
        const counted = await run(tx, built.count);
        const total = Number(counted.records[0]?.get('total') ?? 0);
        const items = (await rows(tx, built.page)).filter((p) => findingVisibleTo(caller, { label: p['sensitivity'] }));
        return { items: items.map(toOut), page: q.page, pageSize: q.pageSize, total };
      },
      { timeoutMs: FINDING_READ_TIMEOUT_MS },
    );
  }

  async update(caller: Caller, id: string, input: unknown): Promise<AuditFindingRecord> {
    const today = this.today();
    const body = intakeUpdateSchemasOn(today).audit_finding.parse(input);
    const { version, ...given } = body;
    if (given.owner !== undefined && ROLE_TABLE.audit_finding[caller.role] !== 'none') {
      if (!(await isOrgMember(this.db, caller, given.owner))) throw BAD_OWNER();
    }
    return this.change(caller, id, version, 'finding update failed', (stored) => {
      const changes: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(given)) {
        if (value === undefined) continue;
        changes[field === 'label' ? 'sensitivity' : field] = value;
      }
      const to = changes['sensitivity'] as Label | undefined;
      const from = stored['sensitivity'] as Label;
      if (to !== undefined && to !== from) {
        if (!isVisible(caller.clearance, to) || !canChangeLabel(caller.role, from, to)) throw LABEL_FORBIDDEN();
      }
      // R15 on the merged finding: a status and closed date that only clash once merged are refused.
      const merged = { ...stored, ...changes };
      const problems = findingDateProblems(
        {
          findingStatus: String(merged['findingStatus']),
          identifiedDate: String(merged['identifiedDate']),
          dueDate: String(merged['dueDate']),
          closedDate: (merged['closedDate'] as string | null | undefined) ?? null,
        },
        today,
      );
      if (problems.length > 0) {
        const message = problems.map((p) => `${p.field}: ${findingDateMessage(p)}`).join('; ');
        throw new ApiError(400, 'validation_failed', message);
      }
      return { action: 'record.updated', changes };
    });
  }

  async retire(caller: Caller, id: string, version: number): Promise<AuditFindingRecord> {
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, 'validation_failed', 'version: must be a whole number from 1.');
    }
    return this.change(caller, id, version, 'finding retire failed', () => ({
      action: 'record.retired',
      changes: { status: 'retired' },
    }));
  }

  /** The controls and risks the finding concerns that the caller can see, with each link. */
  async concerns(caller: Caller, id: string): Promise<{ items: ConcernItem[] }> {
    if (ROLE_TABLE.audit_finding[caller.role] === 'none') throw NOT_FOUND();
    const scope = concernScope(caller);
    const items = await this.readConcerns(caller, CONCERN_KINDS, async (tx) => {
      const [finding] = await rows(tx, findingGetQuery(id, { clearance: caller.clearance }));
      if (!finding || !findingVisibleTo(caller, { label: finding['sensitivity'] })) return null;
      const res = await run(tx, concernsOfQuery(id, scope));
      return res.records.flatMap((r): ConcernItem[] => {
        const kind = kindOf(r.get('labels'));
        if (!kind) return [];
        const end = toConcernEnd(kind, {
          id: r.get('id'),
          number: r.get('number'),
          sensitivity: r.get('label'),
          owner: r.get('owner'),
        });
        if (!concernVisibleTo(caller, end)) return [];
        return [
          {
            kind,
            id: end.id,
            number: end.number,
            name: r.get('name') as string,
            label: end.label,
            status: r.get('status') as string,
            origin: r.get('origin') as ConcernItem['origin'],
            createdAt: r.get('createdAt') as string,
            createdBy: r.get('createdBy') as string,
          },
        ];
      });
    });
    if (!items) throw NOT_FOUND();
    return { items };
  }

  /** Links the finding to another control or risk it concerns. The checks run in this order: the
   * finding and the record visible (404), `canLinkFinding` (403), the link not there yet (409
   * `link_exists`). The link and its `link.created` entry are saved in one transaction, where the
   * checks run again. */
  async addConcern(caller: Caller, id: string, input: unknown): Promise<ConcernLink> {
    const { toId } = concernBodySchema.parse(input);
    const finding = await this.findFinding(caller, id);
    if (!finding) throw NOT_FOUND();
    const target = await this.findConcernTarget(caller, toId);
    if (!target) throw NOT_FOUND();
    if (!canLinkFinding(caller, finding, target)) throw FORBIDDEN();

    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        const { f, t } = await this.endsForWrite(tx, caller, id, target.kind, toId);
        if (!canLinkFinding(caller, f, t)) throw FORBIDDEN();
        const token = `${Date.now()}-${Math.random()}`;
        const now = new Date().toISOString();
        const res = await run(
          tx,
          mergeConcernQuery(f.id, t.kind, t.id, { createdAt: now, createdBy: caller.userId, token }),
        );
        const row = res.records[0];
        if (!row || row.get('created') !== true) throw LINK_EXISTS();
        const p = row.get('p') as Record<string, unknown>;
        const link: ConcernLink = {
          type: CONCERNS,
          fromId: f.id,
          toId: t.id,
          origin: 'manual',
          createdAt: p['createdAt'] as string,
          createdBy: p['createdBy'] as string,
        };
        return {
          result: link,
          audit: {
            action: 'link.created',
            targetType: 'link',
            targetId: linkTargetId(CONCERNS, f.id, t.id),
            before: null,
            after: { ...link },
            meta: { type: CONCERNS, fromNumber: f.number, toNumber: t.number, label: higher(f.label, t.label) },
          },
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const fields = errorFields(err);
      this.log.error({ orgId: caller.orgId, findingId: id, toId, ...fields }, 'finding link create failed');
      throw new FindingWriteFailed(fields.errorCode);
    }
  }

  /** Removes a CONCERNS link added by mistake (S1-011, D201, D207, R11). The checks run in this
   * order: the finding and the record visible and the link there (404), `canLinkFinding` (403), a
   * removable origin (409 `ai_link_review_only`), not the finding's last CONCERNS link, counting
   * the ones the caller can't see (409 `last_concern`). The deletion and its `link.removed` entry
   * are saved in one transaction, with the finding locked, where the checks run again. */
  async removeConcern(caller: Caller, id: string, input: unknown): Promise<RemovedConcern> {
    const { toId } = concernBodySchema.parse(input);
    const finding = await this.findFinding(caller, id);
    if (!finding) throw NOT_FOUND();
    const target = await this.findConcernTarget(caller, toId);
    if (!target) throw NOT_FOUND();
    const found = await this.readConcerns(caller, [target.kind], async (tx) => {
      const row = (await run(tx, findConcernQuery(id, target.kind, toId))).records[0];
      return row ? { origin: row.get('origin') as unknown } : null;
    });
    if (!found) throw NOT_FOUND();
    if (!canLinkFinding(caller, finding, target)) throw FORBIDDEN();
    if (!isRemovableLinkOrigin(found.origin)) throw AI_LINK();

    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        await run(tx, lockFindingQuery(id));
        const { f, t } = await this.endsForWrite(tx, caller, id, target.kind, toId);
        const res = await run(tx, findConcernQuery(f.id, t.kind, t.id));
        const row = res.records[0];
        if (!row) throw NOT_FOUND();
        if (!canLinkFinding(caller, f, t)) throw FORBIDDEN();
        const origin: unknown = row.get('origin');
        if (!isRemovableLinkOrigin(origin)) throw AI_LINK();
        const counted = await run(tx, concernCountQuery(f.id));
        if (Number(counted.records[0]?.get('n') ?? 0) <= 1) throw LAST_CONCERN();
        const deleted = await run(tx, deleteLinkQuery(row.get('rid') as string));
        if (Number(deleted.records[0]?.get('n') ?? 0) !== 1) throw NOT_FOUND();
        const stored = {
          type: CONCERNS,
          fromId: f.id,
          toId: t.id,
          createdAt: row.get('createdAt') as string,
          createdBy: row.get('createdBy') as string,
          origin: origin as string,
        };
        return { result: { type: CONCERNS, fromId: f.id, toId: t.id }, audit: linkRemovedAudit(stored, f, t) };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const fields = errorFields(err);
      this.log.error({ orgId: caller.orgId, findingId: id, toId, ...fields }, 'finding link remove failed');
      throw new FindingWriteFailed(fields.errorCode);
    }
  }

  /** The visible findings concerning one visible control or risk. A role that never views findings
   * gets 403 (a list of a type it can't view); a hidden or missing record is 404. */
  async concerning(
    caller: Caller,
    kind: ConcernKind,
    id: string,
    query: unknown,
  ): Promise<{ items: AuditFindingRecord[] }> {
    const q = parseConcernedFindingsQuery(query);
    if (ROLE_TABLE.audit_finding[caller.role] === 'none') throw FORBIDDEN();
    if (ROLE_TABLE[kind][caller.role] === 'none') throw NOT_FOUND();
    const scope = concernScope(caller, [kind]);
    const items = await this.readConcerns(caller, [kind], async (tx) => {
      const target = concernTargetQuery(id, scope);
      if (!target) return null;
      const res = await run(tx, target);
      const p = res.records[0]?.get('p') as Record<string, unknown> | undefined;
      if (!p || !concernVisibleTo(caller, toConcernEnd(kind, p))) return null;
      const found = await rows(tx, concerningFindingsQuery(kind, id, { clearance: caller.clearance }, q.status));
      return found.filter((f) => findingVisibleTo(caller, { label: f['sensitivity'] })).map(toOut);
    });
    if (!items) throw NOT_FOUND();
    return { items };
  }

  /** The shared path of update and retire: check, lock, compare the version, save, audit. */
  private async change(
    caller: Caller,
    id: string,
    version: number,
    failure: string,
    plan: (stored: Record<string, unknown>) => { action: string; changes: Record<string, unknown> },
  ): Promise<AuditFindingRecord> {
    const cell = ROLE_TABLE.audit_finding[caller.role];
    if (cell === 'none') throw NOT_FOUND();
    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        await run(tx, lockFindingQuery(id));
        const [stored] = await rows(tx, findingForWriteQuery(id));
        if (!stored || !findingVisibleTo(caller, { label: stored['sensitivity'] })) throw NOT_FOUND();
        if (cell !== 'edit') throw FORBIDDEN();
        if (Number(stored['version']) !== version) throw new ApiError(409, 'stale_version', STALE_MESSAGE);
        const { action, changes } = plan(stored);

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [prop, value] of Object.entries(changes)) {
          const old = stored[prop] ?? null;
          if (old === value) continue;
          before[apiName(prop)] = old;
          after[apiName(prop)] = value;
        }
        const now = new Date().toISOString();
        const props = { ...changes, version: version + 1, updatedAt: now, updatedBy: caller.userId };
        const [saved] = await rows(tx, saveFindingQuery(id, toNeo(props)));
        const out = toOut(saved!);
        const label = higher(stored['sensitivity'] as Label, out.label);
        return { result: out, audit: this.entry(action, out, before, after, label) };
      });
    } catch (err) {
      throw this.failed(err, failure, { orgId: caller.orgId, findingId: id });
    }
  }

  /** The finding and the other end, read by the writer inside a write transaction and checked
   * again (404 when either is gone or no longer visible). */
  private async endsForWrite(
    tx: ManagedTransaction,
    caller: Caller,
    findingId: string,
    kind: ConcernKind,
    toId: string,
  ): Promise<{ f: FindingEnd; t: ConcernEnd }> {
    const [fp] = await rows(tx, findingForWriteQuery(findingId));
    const [tp] = await rows(tx, concernForWriteQuery(kind, toId));
    if (!fp || !tp || !findingVisibleTo(caller, { label: fp['sensitivity'] })) throw NOT_FOUND();
    const t = toConcernEnd(kind, tp);
    if (!concernVisibleTo(caller, t)) throw NOT_FOUND();
    return { f: toFindingEnd(fp), t };
  }

  /** A finding's stored properties, if the caller can see it (checked by Neo4j and by our code). */
  private async findFindingProps(caller: Caller, id: string): Promise<Record<string, unknown> | null> {
    if (ROLE_TABLE.audit_finding[caller.role] === 'none') return null;
    const [p] = await this.graph.readAs(
      caller.orgId,
      caller.role,
      caller.clearance,
      (tx) => rows(tx, findingGetQuery(id, { clearance: caller.clearance })),
      { timeoutMs: FINDING_READ_TIMEOUT_MS },
    );
    if (!p || !findingVisibleTo(caller, { label: p['sensitivity'] })) return null;
    return p;
  }

  private async findFinding(caller: Caller, id: string): Promise<FindingEnd | null> {
    const p = await this.findFindingProps(caller, id);
    return p ? toFindingEnd(p) : null;
  }

  /** A control or risk by ID, if the caller can see it; anything else (another type, hidden,
   * missing) is `null`. */
  private async findConcernTarget(caller: Caller, id: string): Promise<ConcernEnd | null> {
    const scope = concernScope(caller);
    const q = concernTargetQuery(id, scope);
    if (!q) return null;
    const found = await this.readConcerns(caller, scope.kinds, async (tx) => {
      const res = await run(tx, q);
      const row = res.records[0];
      return row ? { labels: row.get('labels') as unknown, p: row.get('p') as Record<string, unknown> } : null;
    });
    if (!found) return null;
    const kind = kindOf(found.labels);
    if (!kind) return null;
    const end = toConcernEnd(kind, found.p);
    return concernVisibleTo(caller, end) ? end : null;
  }

  /** Runs a read that can reach controls or risks: as the caller's read-only account, or as the
   * writer when one of the kinds is an "own" cell for the role; every query carries the scope. */
  private readConcerns<T>(
    caller: Caller,
    kinds: readonly ConcernKind[],
    fn: (tx: ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    if (readsAsWriter(caller.role, kinds)) return this.graph.read(caller.orgId, fn);
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, fn, { timeoutMs: FINDING_READ_TIMEOUT_MS });
  }

  private entry(
    action: string,
    out: AuditFindingRecord,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    label: Label,
  ): OutboxAudit {
    return {
      action,
      targetType: 'audit_finding',
      targetId: out.id,
      before,
      after,
      meta: { number: out.number, label },
    };
  }

  /** Our refusals pass through; anything else is logged by its type, code and IDs only. */
  private failed(err: unknown, message: string, ids: Record<string, string>): unknown {
    if (err instanceof ApiError) return err;
    const fields = errorFields(err);
    this.log.error({ ...ids, ...fields }, message);
    return new FindingWriteFailed(fields.errorCode);
  }
}
