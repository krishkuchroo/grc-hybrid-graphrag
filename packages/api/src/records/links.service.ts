// Links between records (S1-005): add one, list a record's links, and the asset map (D204).
// - Adding (D200): both ends must exist in the caller's org and be visible to them (404 whichever
//   end it is), the ontology must allow the type (400 `link_not_allowed`), and the caller must be
//   able to edit either end (`canLinkRecords`, 403). The link and its `link.created` audit entry
//   are saved in one Neo4j transaction (D37, D45.4); the same link twice is 409 `link_exists`.
// - Reading: our code limits every node to the types the role may view, the labels at or below the
//   clearance and, for "own" cells, the caller's own records (D50, D51). The read runs as the
//   caller's read-only role x clearance account (readAs), so Neo4j checks again and hides every
//   link with a hidden end (D45.3, D59). A role with an "own" cell (the Control Owner) reads as the
//   writer instead, because no shared account can know who owns what (S1 shared notes).
// - Log lines about a failed write hold only the error's type and code and the IDs (D163, D164).
import type { ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  LABELS,
  LINK_TYPES,
  NODE_LABELS,
  RECORD_KINDS,
  ROLE_TABLE,
  canLinkRecords,
  isAllowedLink,
  isRecordVisible,
  type Label,
  type LinkType,
  type RecordKind,
  type Role,
} from '@grc/shared';
import type { AuditActor, AuditOutbox } from '../audit/outbox.js';
import { ApiError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import type { GraphService } from '../graph/graph.service.js';
import { buildAssetMap, parseMapDepth, type AssetMap, type MapScope } from './asset-map.js';
import { visibleLabels } from './record-queries.js';
import type { Caller } from './records.service.js';

/** Neo4j stops a links read after this long (D48). */
export const LINK_READ_TIMEOUT_MS = 5000;

const TYPE_NAMES = [...new Set(LINK_TYPES.map((row) => row.type))] as [LinkType, ...LinkType[]];

export const createLinkSchema = z.strictObject({
  type: z.enum(TYPE_NAMES),
  fromId: z.string().min(1).max(200),
  toId: z.string().min(1).max(200),
});

export const linkSchema = z.object({
  type: z.string(),
  fromId: z.string(),
  toId: z.string(),
  origin: z.enum(['manual', 'import', 'ai']),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const linkItemSchema = z.object({
  type: z.string(),
  direction: z.enum(['out', 'in']),
  other: z.object({
    id: z.string(),
    kind: z.enum(RECORD_KINDS),
    number: z.string(),
    name: z.string(),
    label: z.string(),
    status: z.string(),
  }),
  origin: z.enum(['manual', 'import', 'ai']),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const linkListSchema = z.object({ items: z.array(linkItemSchema) });

export type LinkOut = z.infer<typeof linkSchema>;
export type LinkItem = z.infer<typeof linkItemSchema>;

export interface LinksServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  log?: Logger;
}

/** One end of a link, as stored. */
interface End {
  id: string;
  kind: RecordKind;
  number: string;
  label: Label;
  owner: string;
}

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');

const KIND_BY_LABEL: ReadonlyMap<string, RecordKind> = new Map(
  RECORD_KINDS.map((kind) => [NODE_LABELS[kind], kind] as const),
);

function kindOf(labels: unknown): RecordKind | undefined {
  if (!Array.isArray(labels)) return undefined;
  for (const l of labels) {
    const kind = KIND_BY_LABEL.get(String(l));
    if (kind) return kind;
  }
  return undefined;
}

/** Whether the role has an "own" cell on any record type: its reads then run as the writer. */
function readsAsWriter(role: Role): boolean {
  return RECORD_KINDS.some((kind) => ROLE_TABLE[kind][role] === 'edit_own');
}

/** The caller's scope as a Cypher condition on a node: a type the role may view (an "own" cell
 * only for the caller's own records) and a label at or below the clearance. */
function scopeOf(caller: Caller, kinds: readonly RecordKind[] = RECORD_KINDS): MapScope {
  const where = (v: string): string => {
    const parts = kinds.flatMap((kind) => {
      const cell = ROLE_TABLE[kind][caller.role];
      if (cell === 'view' || cell === 'edit') return [`${v}:${NODE_LABELS[kind]}`];
      if (cell === 'edit_own') return [`(${v}:${NODE_LABELS[kind]} AND ${v}.owner = $self)`];
      return [];
    });
    if (parts.length === 0) return 'false';
    return `(${v}.sensitivity IN $visible AND (${parts.join(' OR ')}))`;
  };
  return { where, params: { visible: visibleLabels(caller.clearance), self: caller.userId } };
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

function toEnd(kind: RecordKind, p: Record<string, unknown>): End {
  return {
    id: p['id'] as string,
    kind,
    number: p['number'] as string,
    label: p['sensitivity'] as Label,
    owner: p['owner'] as string,
  };
}

/** Our code's own check of one end (D50, D51), with ownership for the "own" cells. */
function visibleTo(caller: Caller, end: End): boolean {
  const viewer = { role: caller.role, clearance: caller.clearance };
  return isRecordVisible(viewer, { recordType: end.kind, label: end.label, isOwner: end.owner === caller.userId });
}

/** The same key for a link's `link.created` and, later, `link.removed` entries. */
export function linkTargetId(type: string, fromId: string, toId: string): string {
  return `${type}:${fromId}:${toId}`;
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
class LinkWriteFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The link could not be saved.');
    this.name = 'LinkWriteFailed';
  }
}

export class LinksService {
  private readonly graph: LinksServiceDeps['graph'];
  private readonly outbox: LinksServiceDeps['outbox'];
  private readonly log: Logger;

  constructor(deps: LinksServiceDeps) {
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.log = (deps.log ?? createLogger()).child({ context: 'LinksService' });
  }

  async create(caller: Caller, input: unknown): Promise<LinkOut> {
    const { type, fromId, toId } = createLinkSchema.parse(input);
    if (fromId === toId) throw new ApiError(400, 'validation_failed', 'toId: a record cannot link to itself.');
    const from = await this.findVisible(caller, fromId);
    const to = await this.findVisible(caller, toId);
    if (!from || !to) throw NOT_FOUND();
    if (!isAllowedLink(type, from.kind, to.kind)) {
      throw new ApiError(400, 'link_not_allowed', 'This link type is not allowed between these records.');
    }
    if (!canLinkRecords(caller, from, to)) throw FORBIDDEN();

    try {
      return await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        // Read both ends again inside the write, so a change since the check above is seen.
        const a = await this.endForWrite(tx, from.kind, fromId);
        const b = await this.endForWrite(tx, to.kind, toId);
        if (!a || !b || !visibleTo(caller, a) || !visibleTo(caller, b)) throw NOT_FOUND();
        if (!canLinkRecords(caller, a, b)) throw FORBIDDEN();
        const link = await this.merge(tx, type, a, b, caller.userId);
        const meta = { type, fromNumber: a.number, toNumber: b.number, label: higher(a.label, b.label) };
        return {
          result: link,
          audit: {
            action: 'link.created',
            targetType: 'link',
            targetId: linkTargetId(type, fromId, toId),
            before: null,
            after: { ...link },
            meta,
          },
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const fields = errorFields(err);
      this.log.error({ orgId: caller.orgId, type, fromId, toId, ...fields }, 'link create failed');
      throw new LinkWriteFailed(fields.errorCode);
    }
  }

  async list(caller: Caller, kind: RecordKind, id: string): Promise<{ items: LinkItem[] }> {
    if (ROLE_TABLE[kind][caller.role] === 'none') throw FORBIDDEN();
    const self = scopeOf(caller, [kind]);
    const other = scopeOf(caller);
    const items = await this.read(caller, async (tx) => {
      const found = await tx.run(
        `MATCH (n:${NODE_LABELS[kind]} {id: $id}) WHERE ${self.where('n')} RETURN n.id AS id`,
        { ...self.params, id },
      );
      if (found.records.length === 0) return null;
      const res = await tx.run(
        `MATCH (n:${NODE_LABELS[kind]} {id: $id})-[r]-(o)
         WHERE type(r) IN $types AND ${other.where('o')}
         RETURN type(r) AS type, startNode(r) = n AS out, labels(o) AS labels, o.id AS otherId,
           o.number AS number, o.name AS name, o.sensitivity AS label, o.status AS status,
           r.origin AS origin, r.createdAt AS createdAt, r.createdBy AS createdBy
         ORDER BY type, out DESC, number, otherId`,
        { ...other.params, id, types: TYPE_NAMES },
      );
      return res.records.flatMap((r): LinkItem[] => {
        const otherKind = kindOf(r.get('labels'));
        if (!otherKind) return [];
        return [
          {
            type: r.get('type') as string,
            direction: r.get('out') === true ? 'out' : 'in',
            other: {
              id: r.get('otherId') as string,
              kind: otherKind,
              number: r.get('number') as string,
              name: r.get('name') as string,
              label: r.get('label') as string,
              status: r.get('status') as string,
            },
            origin: r.get('origin') as LinkItem['origin'],
            createdAt: r.get('createdAt') as string,
            createdBy: r.get('createdBy') as string,
          },
        ];
      });
    });
    if (!items) throw NOT_FOUND();
    return { items };
  }

  async map(caller: Caller, id: string, query: unknown): Promise<AssetMap> {
    const depth = parseMapDepth(query);
    if (ROLE_TABLE.asset[caller.role] === 'none') throw FORBIDDEN();
    const scope = scopeOf(caller, ['asset']);
    const map = await this.read(caller, (tx) => buildAssetMap(tx, id, depth, scope));
    if (!map) throw NOT_FOUND();
    return map;
  }

  /** One record by ID, of any type, if the caller can see it (checked by Neo4j and our query). */
  private async findVisible(caller: Caller, id: string): Promise<End | null> {
    const scope = scopeOf(caller);
    const branches = RECORD_KINDS.filter((kind) => ROLE_TABLE[kind][caller.role] !== 'none').map(
      (kind) => `MATCH (n:${NODE_LABELS[kind]} {id: $id}) WHERE ${scope.where('n')} RETURN n`,
    );
    if (branches.length === 0) return null;
    const found = await this.read(caller, async (tx) => {
      const res = await tx.run(
        `CALL () { ${branches.join(' UNION ')} } RETURN labels(n) AS labels, properties(n) AS p LIMIT 1`,
        { ...scope.params, id },
      );
      return res.records[0];
    });
    if (!found) return null;
    const kind = kindOf(found.get('labels'));
    if (!kind) return null;
    const end = toEnd(kind, found.get('p') as Record<string, unknown>);
    return visibleTo(caller, end) ? end : null;
  }

  private async endForWrite(tx: ManagedTransaction, kind: RecordKind, id: string): Promise<End | null> {
    const res = await tx.run(`MATCH (n:${NODE_LABELS[kind]} {id: $id}) RETURN properties(n) AS p`, { id });
    const p = res.records[0]?.get('p') as Record<string, unknown> | undefined;
    return p ? toEnd(kind, p) : null;
  }

  /** Adds the link unless the same type already joins the two records (409). MERGE locks both
   * ends, so two callers adding the same link at once get one link and one 409. */
  private async merge(tx: ManagedTransaction, type: LinkType, a: End, b: End, userId: string): Promise<LinkOut> {
    const token = `${Date.now()}-${Math.random()}`;
    const res = await tx.run(
      `MATCH (a:${NODE_LABELS[a.kind]} {id: $fromId}), (b:${NODE_LABELS[b.kind]} {id: $toId})
       MERGE (a)-[r:${type}]->(b)
       ON CREATE SET r.createdAt = $now, r.createdBy = $userId, r.origin = 'manual', r.__created = $token
       WITH r, coalesce(r.__created = $token, false) AS created
       REMOVE r.__created
       RETURN created, properties(r) AS p`,
      { fromId: a.id, toId: b.id, now: new Date().toISOString(), userId, token },
    );
    const row = res.records[0];
    if (!row || row.get('created') !== true) throw new ApiError(409, 'link_exists', 'This link already exists.');
    const p = row.get('p') as Record<string, unknown>;
    return {
      type,
      fromId: a.id,
      toId: b.id,
      origin: 'manual',
      createdAt: p['createdAt'] as string,
      createdBy: p['createdBy'] as string,
    };
  }

  /** Runs a read as the caller's read-only account, or as the writer for a role with an "own"
   * cell; every query also carries the caller's scope. */
  private read<T>(caller: Caller, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    if (readsAsWriter(caller.role)) return this.graph.read(caller.orgId, fn);
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, fn, { timeoutMs: LINK_READ_TIMEOUT_MS });
  }
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

