// The audit findings' Cypher (S3-010): the list query with its filters and sort (D47), one finding,
// the controls and risks a finding concerns, the findings concerning one control or risk, and the
// writes. Every name put into the Cypher text comes from the fixed lists below; every value the
// caller sends goes in as a parameter.
// - A finding is visible to a role that may view audit findings (D50), when its label is at or
//   below the caller's clearance (D51). Its CONCERNS links show only when the other end is visible
//   too: a control or risk whose type the role may view (a Control Owner only their own controls,
//   the "own" cell) and whose label is at or below the clearance.
// - `due=overdue` is `isFindingOverdue` (R15): due before today with status `open` or
//   `in_progress`. `due=next_30_days` is due from today to 30 days ahead with one of those statuses.
//   Dates are stored as `YYYY-MM-DD` text, so comparing them as text compares the days.
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  INTAKE_NODE_LABELS,
  LABELS,
  NODE_LABELS,
  OPEN_FINDING_STATUSES,
  ROLE_TABLE,
  type Label,
  type Role,
} from '@grc/shared';
import { pageQuerySchema } from '../../common/paging.js';
import { visibleLabels } from '../../records/record-queries.js';

/** The finding's node label (D67). */
export const FINDING_LABEL = INTAKE_NODE_LABELS.audit_finding;

/** The one link type a finding has (D67): AuditFinding -CONCERNS-> Control or Risk. */
export const CONCERNS = 'CONCERNS';

/** The record kinds a finding can concern, in the order they're looked up. */
export const CONCERN_KINDS = ['control', 'risk'] as const;
export type ConcernKind = (typeof CONCERN_KINDS)[number];

export const DUE_FILTERS = ['overdue', 'next_30_days'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** How far ahead `due=next_30_days` looks, in days, today included. */
export const DUE_SOON_DAYS = 30;

const SORT_FIELDS = ['number', 'name', 'severity', 'dueDate', 'identifiedDate', 'updatedAt'] as const;
const SORT_VALUES = SORT_FIELDS.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];

export const findingListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  sort: z.enum(SORT_VALUES).default('number'),
  status: z.enum(['active', 'retired', 'all']).default('active'),
  owner: z.string().min(1).optional(),
  label: z.enum(LABELS).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  findingStatus: z.enum(FINDING_STATUSES).optional(),
  due: z.enum(DUE_FILTERS).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export type FindingListQuery = z.infer<typeof findingListQuerySchema>;

/** Checks a list query. Unknown filters and sort fields are refused (a ZodError, answered as 400). */
export function parseFindingListQuery(query: unknown): FindingListQuery {
  return findingListQuerySchema.parse(query ?? {});
}

/** The query of the findings concerning one control or risk: only the record status. */
export const concernedFindingsQuerySchema = z.strictObject({
  status: z.enum(['active', 'retired', 'all']).default('active'),
});

export type ConcernedFindingsQuery = z.infer<typeof concernedFindingsQuerySchema>;

export function parseConcernedFindingsQuery(query: unknown): ConcernedFindingsQuery {
  return concernedFindingsQuerySchema.parse(query ?? {});
}

/** Today's date in UTC, as `YYYY-MM-DD`. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The parts of a real `YYYY-MM-DD` date, or `null` (2026-02-30 is not one). */
function dateParts(date: unknown): [number, number, number] | null {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return [y, m, d];
}

/** `date` plus `days` days, as `YYYY-MM-DD`. A malformed date throws. */
export function addDays(date: string, days: number): string {
  const parts = dateParts(date);
  if (!parts) throw new Error('date must be a YYYY-MM-DD date');
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

/** Who is reading a finding: the labels they may see. */
export interface FindingScope {
  clearance: Label;
}

/** The `due` filter as a Cypher condition on `f`, around `today`. */
export function dueWhere(due: DueFilter, today: string, params: Record<string, unknown>): string {
  if (!dateParts(today)) throw new Error('today must be a YYYY-MM-DD date');
  params['today'] = today;
  params['openStatuses'] = [...OPEN_FINDING_STATUSES];
  if (due === 'overdue') return '(f.dueDate < $today AND f.findingStatus IN $openStatuses)';
  params['dueSoonEnd'] = addDays(today, DUE_SOON_DAYS);
  return '(f.dueDate >= $today AND f.dueDate <= $dueSoonEnd AND f.findingStatus IN $openStatuses)';
}

/** One finding by ID, if its label is visible. */
export function findingGetQuery(id: string, scope: FindingScope): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $id}) WHERE f.sensitivity IN $visible RETURN properties(f) AS p`,
    params: { id, visible: visibleLabels(scope.clearance) },
  };
}

const SEVERITY_RANK = `CASE f.severity ${FINDING_SEVERITIES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END`;

const SORT_EXPR: Record<(typeof SORT_FIELDS)[number], string> = {
  number: 'f.number',
  name: 'f.name',
  severity: SEVERITY_RANK,
  dueDate: 'f.dueDate',
  identifiedDate: 'f.identifiedDate',
  updatedAt: 'f.updatedAt',
};

/** The count and page queries for a checked list query; `today` is needed for the `due` filter. */
export function findingListQueries(
  q: FindingListQuery,
  scope: FindingScope,
  today: string,
): { count: BuiltQuery; page: BuiltQuery } {
  const params: Record<string, unknown> = { visible: visibleLabels(scope.clearance) };
  const where = ['f.sensitivity IN $visible'];
  if (q.status !== 'all') {
    params['status'] = q.status;
    where.push('f.status = $status');
  }
  if (q.owner !== undefined) {
    params['owner'] = q.owner;
    where.push('f.owner = $owner');
  }
  if (q.label !== undefined) {
    params['label'] = q.label;
    where.push('f.sensitivity = $label');
  }
  if (q.severity !== undefined) {
    params['severity'] = q.severity;
    where.push('f.severity = $severity');
  }
  if (q.findingStatus !== undefined) {
    params['findingStatus'] = q.findingStatus;
    where.push('f.findingStatus = $findingStatus');
  }
  if (q.due !== undefined) where.push(dueWhere(q.due, today, params));
  if (q.q !== undefined) {
    params['q'] = q.q.toLowerCase();
    where.push('(toLower(f.name) CONTAINS $q OR toLower(f.number) CONTAINS $q)');
  }
  const match = `MATCH (f:${FINDING_LABEL}) WHERE ${where.join(' AND ')}`;
  const descending = q.sort.startsWith('-');
  const field = (descending ? q.sort.slice(1) : q.sort) as (typeof SORT_FIELDS)[number];
  const dir = descending ? 'DESC' : 'ASC';
  const order = field === 'number' ? `f.number ${dir}` : `${SORT_EXPR[field]} ${dir}, f.number ${dir}`;
  return {
    count: { text: `${match} RETURN count(f) AS total`, params },
    page: {
      text: `${match} RETURN properties(f) AS p ORDER BY ${order} SKIP $skip LIMIT $limit`,
      params: { ...params, skip: neo4j.int((q.page - 1) * q.pageSize), limit: neo4j.int(q.pageSize) },
    },
  };
}

/** A role's view of the records a finding can concern, as a Cypher condition on a node: a type the
 * role may view (an "own" cell only for the caller's own records) and a visible label. */
export interface ConcernScope {
  where: (v: string) => string;
  params: Record<string, unknown>;
  kinds: ConcernKind[];
}

export function concernScope(
  caller: { role: Role; clearance: Label; userId: string },
  kinds: readonly ConcernKind[] = CONCERN_KINDS,
): ConcernScope {
  const cellOf = (kind: ConcernKind): string => ROLE_TABLE[kind][caller.role];
  const open = kinds.filter((kind) => ['view', 'edit', 'edit_own'].includes(cellOf(kind)));
  const where = (v: string): string => {
    if (open.length === 0) return 'false';
    const parts = open.map((kind) =>
      cellOf(kind) === 'edit_own' ? `(${v}:${NODE_LABELS[kind]} AND ${v}.owner = $self)` : `${v}:${NODE_LABELS[kind]}`,
    );
    return `(${v}.sensitivity IN $visible AND (${parts.join(' OR ')}))`;
  };
  return { where, params: { visible: visibleLabels(caller.clearance), self: caller.userId }, kinds: open };
}

/** Whether a read that reaches these kinds must run as the writer: only when one of them is an
 * "own" cell for the role (no shared account can know who owns what, S1 shared notes). */
export function readsAsWriter(role: Role, kinds: readonly ConcernKind[] = CONCERN_KINDS): boolean {
  return kinds.some((kind) => ROLE_TABLE[kind][role] === 'edit_own');
}

/** A control or risk by ID, if the scope lets the reader see it. `null` when no kind is open to
 * the role (nothing to ask Neo4j). */
export function concernTargetQuery(id: string, scope: ConcernScope): BuiltQuery | null {
  if (scope.kinds.length === 0) return null;
  const branches = scope.kinds.map(
    (kind) => `MATCH (n:${NODE_LABELS[kind]} {id: $id}) WHERE ${scope.where('n')} RETURN n`,
  );
  return {
    text: `CALL () { ${branches.join(' UNION ')} } RETURN labels(n) AS labels, properties(n) AS p LIMIT 1`,
    params: { ...scope.params, id },
  };
}

/** The controls and risks a finding concerns that the scope lets the reader see, with the link. */
export function concernsOfQuery(findingId: string, scope: ConcernScope): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $id})-[r:${CONCERNS}]->(o)
     WHERE ${scope.where('o')}
     RETURN labels(o) AS labels, o.id AS id, o.number AS number, o.name AS name, o.sensitivity AS label,
       o.owner AS owner, o.status AS status, r.origin AS origin, r.createdAt AS createdAt,
       r.createdBy AS createdBy
     ORDER BY number, id`,
    params: { ...scope.params, id: findingId },
  };
}

/** The visible findings concerning one control or risk (found through `concernTargetQuery` first). */
export function concerningFindingsQuery(
  kind: ConcernKind,
  id: string,
  scope: FindingScope,
  status: ConcernedFindingsQuery['status'],
): BuiltQuery {
  const params: Record<string, unknown> = { id, visible: visibleLabels(scope.clearance) };
  const where = ['f.sensitivity IN $visible'];
  if (status !== 'all') {
    params['status'] = status;
    where.push('f.status = $status');
  }
  return {
    text: `MATCH (f:${FINDING_LABEL})-[:${CONCERNS}]->(o:${NODE_LABELS[kind]} {id: $id})
     WHERE ${where.join(' AND ')}
     WITH DISTINCT f
     RETURN properties(f) AS p ORDER BY f.number`,
    params,
  };
}

/** Write-locks a finding for the rest of this transaction (a property set and removed again, so the
 * node is unchanged), so its version and its links are read after any other writer's: two
 * removals of its last two links run one after the other, and the second sees the first's. */
export function lockFindingQuery(id: string): BuiltQuery {
  return { text: `MATCH (f:${FINDING_LABEL} {id: $id}) SET f.__lock = true REMOVE f.__lock`, params: { id } };
}

/** The finding's stored properties, read by the writer inside its write transaction. */
export function findingForWriteQuery(id: string): BuiltQuery {
  return { text: `MATCH (f:${FINDING_LABEL} {id: $id}) RETURN properties(f) AS p`, params: { id } };
}

/** A control or risk's stored properties, read by the writer inside its write transaction. */
export function concernForWriteQuery(kind: ConcernKind, id: string): BuiltQuery {
  return { text: `MATCH (n:${NODE_LABELS[kind]} {id: $id}) RETURN properties(n) AS p`, params: { id } };
}

/** Sets the changed properties. A `null` value removes the property. */
export function saveFindingQuery(id: string, props: Record<string, unknown>): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $id}) SET f += $props RETURN properties(f) AS p`,
    params: { id, props },
  };
}

/** Creates the finding and its CONCERNS link (origin `manual`) together; no row when the concerned
 * record is gone. */
export function createFindingQuery(
  kind: ConcernKind,
  concernsId: string,
  props: Record<string, unknown>,
  link: { createdAt: string; createdBy: string },
): BuiltQuery {
  return {
    text: `MATCH (o:${NODE_LABELS[kind]} {id: $concernsId})
     CREATE (f:${FINDING_LABEL})
     SET f = $props
     CREATE (f)-[r:${CONCERNS}]->(o)
     SET r.createdAt = $createdAt, r.createdBy = $createdBy, r.origin = 'manual'
     RETURN properties(f) AS p`,
    params: { concernsId, props, createdAt: link.createdAt, createdBy: link.createdBy },
  };
}

/** The one CONCERNS link from the finding to the record, if there is one. */
export function findConcernQuery(findingId: string, kind: ConcernKind, toId: string): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $findingId})-[r:${CONCERNS}]->(o:${NODE_LABELS[kind]} {id: $toId})
     RETURN elementId(r) AS rid, r.origin AS origin, r.createdAt AS createdAt, r.createdBy AS createdBy
     ORDER BY r.createdAt LIMIT 1`,
    params: { findingId, toId },
  };
}

/** How many CONCERNS links the finding has, whoever can see their other ends (R11). */
export function concernCountQuery(findingId: string): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $findingId})-[r:${CONCERNS}]->() RETURN count(r) AS n`,
    params: { findingId },
  };
}

/** Adds the CONCERNS link unless one already joins the two records (`created` false). MERGE locks
 * both ends, so two callers adding the same link at once get one link. */
export function mergeConcernQuery(
  findingId: string,
  kind: ConcernKind,
  toId: string,
  link: { createdAt: string; createdBy: string; token: string },
): BuiltQuery {
  return {
    text: `MATCH (f:${FINDING_LABEL} {id: $findingId}), (o:${NODE_LABELS[kind]} {id: $toId})
     MERGE (f)-[r:${CONCERNS}]->(o)
     ON CREATE SET r.createdAt = $createdAt, r.createdBy = $createdBy, r.origin = 'manual', r.__created = $token
     WITH r, coalesce(r.__created = $token, false) AS created
     REMOVE r.__created
     RETURN created, properties(r) AS p`,
    params: { findingId, toId, ...link },
  };
}

/** Deletes one link by its element ID. */
export function deleteLinkQuery(elementId: string): BuiltQuery {
  return {
    text: `MATCH ()-[r]->() WHERE elementId(r) = $rid DELETE r RETURN count(*) AS n`,
    params: { rid: elementId },
  };
}
