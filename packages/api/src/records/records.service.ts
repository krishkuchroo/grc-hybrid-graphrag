// The records service (S1-003): create, read, list, update and retire assets, risks, controls,
// policies and incidents, with every rule the plan sets.
// - Our code checks the org, the D50 role table and the D51 label first (D45.3, D59). Reads then
//   run as the caller's read-only role x clearance account (readAs), so Neo4j checks again. The one
//   exception is a Control Owner's controls: no shared account can know who owns what, so those
//   reads run as the writer, always limited to their own controls and their clearance.
// - Each change and its audit entry are saved in one Neo4j transaction (D37, D45.4).
// - Stale saves are refused (D69), records are retired, never deleted, and numbers come from a
//   per-org, per-type counter (D68, D196).
// - Log lines about a failed write hold only the error's type and code and the IDs (D163, D164).
import { randomUUID } from 'node:crypto';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import {
  LABELS,
  ROLE_TABLE,
  canChangeLabel,
  createSchemas,
  defaultLabel,
  isVisible,
  riskRating,
  updateSchemas,
  type Label,
  type RecordKind,
  type Role,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../audit/outbox.js';
import { ApiError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import type { Paged } from '../common/paging.js';
import type { Db } from '../db/client.js';
import type { GraphService } from '../graph/graph.service.js';
import { isOrgMember } from './owners.js';
import { NUMBER_CLASH_ATTEMPTS, isNumberClash, takeNumber } from './record-numbers.js';
import {
  createQuery,
  getQuery,
  listQueries,
  lockQuery,
  parseListQuery,
  readForWriteQuery,
  saveQuery,
  type BuiltQuery,
  type ReadScope,
} from './record-queries.js';

/** Neo4j stops a record read after this long (D48). */
export const RECORD_READ_TIMEOUT_MS = 5000;

export interface Caller {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
  apiKeyId?: string;
}

export interface RecordOut {
  id: string;
  number: string;
  sourceIds: string[];
  name: string;
  label: Label;
  status: 'active' | 'retired';
  owner: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  origin: 'manual' | 'import' | 'ai';
  rating?: { score: number; band: string };
  [field: string]: unknown;
}

export interface RecordsServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  db: Db;
  log?: Logger;
}

const STALE_MESSAGE = 'This record changed since you opened it. Reload it and try again.';
const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');
const LABEL_FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not set this label.');
const BAD_OWNER = (): ApiError =>
  new ApiError(400, 'validation_failed', 'owner: must be a member of this organization.');

/** Each type's own fields, in the shared schemas' order. */
function ownFields(kind: RecordKind): string[] {
  return Object.keys(createSchemas[kind].shape).filter((k) => k !== 'name' && k !== 'owner' && k !== 'label');
}

/** Integers go to Neo4j as integers, not floats. */
function toNeo(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === 'number' && Number.isInteger(v) ? neo4j.int(v) : v]),
  );
}

/** A stored node as the API returns it (the label as `label`), with a risk's rating (D197). */
function toOut(kind: RecordKind, p: Record<string, unknown>): RecordOut {
  const out: RecordOut = {
    id: p['id'] as string,
    number: p['number'] as string,
    sourceIds: (p['sourceIds'] as string[] | undefined) ?? [],
    name: p['name'] as string,
    label: p['sensitivity'] as Label,
    status: p['status'] as RecordOut['status'],
    owner: p['owner'] as string,
    version: Number(p['version']),
    createdAt: p['createdAt'] as string,
    createdBy: p['createdBy'] as string,
    updatedAt: p['updatedAt'] as string,
    updatedBy: p['updatedBy'] as string,
    origin: p['origin'] as RecordOut['origin'],
  };
  for (const field of ownFields(kind)) {
    const v = p[field];
    out[field] = typeof v === 'bigint' ? Number(v) : v;
  }
  if (kind === 'risk') out.rating = riskRating(Number(p['impact']), Number(p['likelihood']));
  return out;
}

/** The API's name for a stored property (`sensitivity` is `label`). */
function apiName(prop: string): string {
  return prop === 'sensitivity' ? 'label' : prop;
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
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
class RecordWriteFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The record could not be saved.');
    this.name = 'RecordWriteFailed';
  }
}

async function rows(tx: ManagedTransaction, q: BuiltQuery): Promise<Record<string, unknown>[]> {
  const res = await tx.run(q.text, q.params);
  return res.records.map((r) => r.get('p') as Record<string, unknown>);
}

export class RecordsService {
  private readonly graph: RecordsServiceDeps['graph'];
  private readonly outbox: RecordsServiceDeps['outbox'];
  private readonly db: Db;
  private readonly log: Logger;

  constructor(deps: RecordsServiceDeps) {
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.db = deps.db;
    this.log = (deps.log ?? createLogger()).child({ context: 'RecordsService' });
  }

  async create(caller: Caller, kind: RecordKind, input: unknown): Promise<RecordOut> {
    const body = createSchemas[kind].parse(input) as Record<string, unknown>;
    if (ROLE_TABLE[kind][caller.role] !== 'edit') throw FORBIDDEN();
    const label = (body['label'] as Label | undefined) ?? defaultLabel(kind, body as { dataClassification?: Label });
    if (!isVisible(caller.clearance, label)) throw LABEL_FORBIDDEN(); // D198
    const owner = body['owner'] as string | undefined;
    if (owner === undefined && caller.apiKeyId !== undefined) {
      throw new ApiError(400, 'validation_failed', 'owner: an API key must name an owner.');
    }
    if (owner !== undefined && !(await isOrgMember(this.db, caller, owner))) throw BAD_OWNER();

    const fields: Record<string, unknown> = { name: body['name'] };
    for (const f of ownFields(kind)) fields[f] = body[f];
    for (let attempt = 1; ; attempt += 1) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const props = {
        id,
        sourceIds: [],
        ...fields,
        sensitivity: label,
        status: 'active',
        owner: owner ?? caller.userId,
        version: 1,
        createdAt: now,
        createdBy: caller.userId,
        updatedAt: now,
        updatedBy: caller.userId,
        origin: 'manual',
      };
      try {
        return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
          const number = await takeNumber(tx, kind);
          const [saved] = await rows(tx, createQuery(kind, toNeo({ ...props, number })));
          const out = toOut(kind, saved!);
          const after: Record<string, unknown> = { ...fields, label, owner: out.owner, status: 'active' };
          return { result: out, audit: this.entry('record.created', kind, out, null, after, label) };
        });
      } catch (err) {
        if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
        throw this.failed(err, 'record create failed', { orgId: caller.orgId, kind, recordId: id });
      }
    }
  }

  async get(caller: Caller, kind: RecordKind, id: string): Promise<RecordOut> {
    const cell = ROLE_TABLE[kind][caller.role];
    if (cell === 'none') throw NOT_FOUND();
    const [found] = await this.read(caller, kind, (scope) => getQuery(kind, id, scope), rows);
    if (!found) throw NOT_FOUND();
    return toOut(kind, found);
  }

  async list(caller: Caller, kind: RecordKind, query: unknown): Promise<Paged<RecordOut>> {
    const q = parseListQuery(kind, query);
    if (ROLE_TABLE[kind][caller.role] === 'none') throw FORBIDDEN();
    return this.read(
      caller,
      kind,
      (scope) => listQueries(kind, q, scope),
      async (tx, built) => {
        const counted = await tx.run(built.count.text, built.count.params);
        const total = Number(counted.records[0]?.get('total') ?? 0);
        const items = (await rows(tx, built.page)).map((p) => toOut(kind, p));
        return { items, page: q.page, pageSize: q.pageSize, total };
      },
    );
  }

  async update(caller: Caller, kind: RecordKind, id: string, input: unknown): Promise<RecordOut> {
    const body = updateSchemas[kind].parse(input) as Record<string, unknown>;
    const { version, ...given } = body as { version: number } & Record<string, unknown>;
    const owner = given['owner'] as string | undefined;
    if (owner !== undefined && ROLE_TABLE[kind][caller.role] !== 'none') {
      if (!(await isOrgMember(this.db, caller, owner))) throw BAD_OWNER();
    }
    return this.change(caller, kind, id, version, 'record update failed', (stored) => {
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
      return { action: 'record.updated', changes };
    });
  }

  async retire(caller: Caller, kind: RecordKind, id: string, version: number): Promise<RecordOut> {
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, 'validation_failed', 'version: must be a whole number from 1.');
    }
    return this.change(caller, kind, id, version, 'record retire failed', () => ({
      action: 'record.retired',
      changes: { status: 'retired' },
    }));
  }

  /** The shared path of update and retire: check, lock, compare the version, save, audit. */
  private async change(
    caller: Caller,
    kind: RecordKind,
    id: string,
    version: number,
    failure: string,
    plan: (stored: Record<string, unknown>) => { action: string; changes: Record<string, unknown> },
  ): Promise<RecordOut> {
    const cell = ROLE_TABLE[kind][caller.role];
    if (cell === 'none') throw NOT_FOUND();
    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        await tx.run(lockQuery(kind, id).text, lockQuery(kind, id).params);
        const [stored] = await rows(tx, readForWriteQuery(kind, id));
        if (!stored || !isVisible(caller.clearance, stored['sensitivity'] as string)) throw NOT_FOUND();
        if (cell === 'edit_own' && stored['owner'] !== caller.userId) throw NOT_FOUND();
        if (cell !== 'edit' && cell !== 'edit_own') throw FORBIDDEN();
        if (Number(stored['version']) !== version) throw new ApiError(409, 'stale_version', STALE_MESSAGE);
        const { action, changes } = plan(stored);

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [prop, value] of Object.entries(changes)) {
          if (stored[prop] === value) continue;
          before[apiName(prop)] = stored[prop] ?? null;
          after[apiName(prop)] = value;
        }
        const now = new Date().toISOString();
        const props = { ...changes, version: version + 1, updatedAt: now, updatedBy: caller.userId };
        const [saved] = await rows(tx, saveQuery(kind, id, toNeo(props)));
        const out = toOut(kind, saved!);
        const label = higher(stored['sensitivity'] as Label, out.label);
        return { result: out, audit: this.entry(action, kind, out, before, after, label) };
      });
    } catch (err) {
      throw this.failed(err, failure, { orgId: caller.orgId, kind, recordId: id });
    }
  }

  /** Runs a read as the caller's read-only account, or, for a Control Owner's controls, as the
   * writer limited to their own controls. Both are limited to their clearance's labels. */
  private async read<Q, T>(
    caller: Caller,
    kind: RecordKind,
    build: (scope: ReadScope) => Q,
    run: (tx: ManagedTransaction, built: Q) => Promise<T>,
  ): Promise<T> {
    if (ROLE_TABLE[kind][caller.role] === 'edit_own') {
      const built = build({ clearance: caller.clearance, ownerOnly: caller.userId });
      return this.graph.read(caller.orgId, (tx) => run(tx, built));
    }
    const built = build({ clearance: caller.clearance });
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, (tx) => run(tx, built), {
      timeoutMs: RECORD_READ_TIMEOUT_MS,
    });
  }

  private entry(
    action: string,
    kind: RecordKind,
    out: RecordOut,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    label: Label,
  ): OutboxAudit {
    return { action, targetType: kind, targetId: out.id, before, after, meta: { number: out.number, label } };
  }

  /** Our refusals pass through; anything else is logged by its type, code and IDs only. */
  private failed(err: unknown, message: string, ids: Record<string, string>): unknown {
    if (err instanceof ApiError) return err;
    const fields = errorFields(err);
    this.log.error({ ...ids, ...fields }, message);
    return new RecordWriteFailed(fields.errorCode);
  }
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}
