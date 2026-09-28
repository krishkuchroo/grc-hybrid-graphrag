// The records service's Cypher (S1-003): reading one record, and building the list query from its
// filters and sort (D47). Every name put into the Cypher text comes from the fixed lists below;
// every value the caller sends goes in as a parameter.
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import {
  ASSET_TYPES,
  CONTROL_STATUSES,
  CRITICALITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  LABELS,
  NODE_LABELS,
  RISK_SCALE,
  isVisible,
  riskRating,
  type Label,
  type RecordKind,
  type RiskBand,
} from '@grc/shared';
import { pageQuerySchema } from '../common/paging.js';

export const RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly RiskBand[];

/** Each type's list filters (besides status, owner, label and q). */
const LIST_FIELDS = {
  asset: { assetType: z.enum(ASSET_TYPES), criticality: z.enum(CRITICALITIES) },
  risk: { band: z.enum(RISK_BANDS) },
  control: { controlStatus: z.enum(CONTROL_STATUSES), framework: z.string().trim().min(1) },
  policy: {},
  incident: { severity: z.enum(INCIDENT_SEVERITIES), incidentStatus: z.enum(INCIDENT_STATUSES) },
} as const;

const SORT_FIELDS = ['number', 'name', 'updatedAt'] as const;

function sortValues(kind: RecordKind): [string, ...string[]] {
  const fields: string[] = [...SORT_FIELDS, ...(kind === 'risk' ? ['score'] : [])];
  return fields.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];
}

function listQuerySchema(kind: RecordKind) {
  const own = Object.fromEntries(Object.entries(LIST_FIELDS[kind]).map(([k, s]) => [k, s.optional()]));
  return z.strictObject({
    page: pageQuerySchema.shape.page,
    pageSize: pageQuerySchema.shape.pageSize,
    sort: z.enum(sortValues(kind)).default('number'),
    status: z.enum(['active', 'retired', 'all']).default('active'),
    owner: z.string().min(1).optional(),
    label: z.enum(LABELS).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    ...own,
  });
}

export interface ListQuery {
  page: number;
  pageSize: number;
  sort: string;
  status: 'active' | 'retired' | 'all';
  owner?: string;
  label?: Label;
  q?: string;
  [field: string]: unknown;
}

/** Checks a list query. Unknown filters and sort fields are refused (a ZodError, answered as 400). */
export function parseListQuery(kind: RecordKind, query: unknown): ListQuery {
  return listQuerySchema(kind).parse(query ?? {}) as ListQuery;
}

/** The labels at or below a clearance. */
export function visibleLabels(clearance: Label): Label[] {
  return LABELS.filter((l) => isVisible(clearance, l));
}

/** The scores (impact x likelihood) that fall in a risk band (D197). */
export function bandScores(band: RiskBand): number[] {
  const scores = new Set<number>();
  for (const i of RISK_SCALE) {
    for (const l of RISK_SCALE) {
      const r = riskRating(i, l);
      if (r.band === band) scores.add(r.score);
    }
  }
  return [...scores].sort((a, b) => a - b);
}

/** Who is reading: the labels they may see, and (for a Control Owner's controls) their own ID. */
export interface ReadScope {
  clearance: Label;
  ownerOnly?: string;
}

function scopeWhere(scope: ReadScope, params: Record<string, unknown>): string[] {
  params['visible'] = visibleLabels(scope.clearance);
  const where = ['n.sensitivity IN $visible'];
  if (scope.ownerOnly !== undefined) {
    params['self'] = scope.ownerOnly;
    where.push('n.owner = $self');
  }
  return where;
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

/** One record by ID, if the scope lets the reader see it. */
export function getQuery(kind: RecordKind, id: string, scope: ReadScope): BuiltQuery {
  const params: Record<string, unknown> = { id };
  const where = scopeWhere(scope, params);
  return {
    text: `MATCH (n:${NODE_LABELS[kind]} {id: $id}) WHERE ${where.join(' AND ')} RETURN properties(n) AS p`,
    params,
  };
}

const SORT_EXPR: Record<string, string> = {
  number: 'n.number',
  name: 'n.name',
  updatedAt: 'n.updatedAt',
  score: 'n.impact * n.likelihood',
};

/** The count and page queries for a checked list query. */
export function listQueries(kind: RecordKind, q: ListQuery, scope: ReadScope): { count: BuiltQuery; page: BuiltQuery } {
  const params: Record<string, unknown> = {};
  const where = scopeWhere(scope, params);
  if (q.status !== 'all') {
    params['status'] = q.status;
    where.push('n.status = $status');
  }
  if (q.owner !== undefined) {
    params['owner'] = q.owner;
    where.push('n.owner = $owner');
  }
  if (q.label !== undefined) {
    params['label'] = q.label;
    where.push('n.sensitivity = $label');
  }
  for (const field of Object.keys(LIST_FIELDS[kind])) {
    const value = q[field];
    if (value === undefined) continue;
    if (field === 'band') {
      params['bandScores'] = bandScores(value as RiskBand).map((s) => neo4j.int(s));
      where.push('n.impact * n.likelihood IN $bandScores');
    } else {
      params[field] = value;
      where.push(`n.${field} = $${field}`);
    }
  }
  if (q.q !== undefined) {
    params['q'] = q.q.toLowerCase();
    where.push('(toLower(n.name) CONTAINS $q OR toLower(n.number) CONTAINS $q)');
  }
  const match = `MATCH (n:${NODE_LABELS[kind]}) WHERE ${where.join(' AND ')}`;
  const descending = q.sort.startsWith('-');
  const field = descending ? q.sort.slice(1) : q.sort;
  const dir = descending ? 'DESC' : 'ASC';
  const order = field === 'number' ? `n.number ${dir}` : `${SORT_EXPR[field]} ${dir}, n.number ${dir}`;
  return {
    count: { text: `${match} RETURN count(n) AS total`, params },
    page: {
      text: `${match} RETURN properties(n) AS p ORDER BY ${order} SKIP $skip LIMIT $limit`,
      params: { ...params, skip: neo4j.int((q.page - 1) * q.pageSize), limit: neo4j.int(q.pageSize) },
    },
  };
}

/** Locks a record for this write transaction, so its version is read after any other writer's. */
export function lockQuery(kind: RecordKind, id: string): BuiltQuery {
  return { text: `MATCH (n:${NODE_LABELS[kind]} {id: $id}) SET n.__lock = true`, params: { id } };
}

/** The record's stored properties, read by the writer inside its write transaction. */
export function readForWriteQuery(kind: RecordKind, id: string): BuiltQuery {
  return {
    text: `MATCH (n:${NODE_LABELS[kind]} {id: $id}) RETURN properties(n) AS p`,
    params: { id },
  };
}

/** Sets the changed properties and releases the lock. */
export function saveQuery(kind: RecordKind, id: string, props: Record<string, unknown>): BuiltQuery {
  return {
    text: `MATCH (n:${NODE_LABELS[kind]} {id: $id}) SET n += $props REMOVE n.__lock RETURN properties(n) AS p`,
    params: { id, props },
  };
}

export function createQuery(kind: RecordKind, props: Record<string, unknown>): BuiltQuery {
  return { text: `CREATE (n:${NODE_LABELS[kind]}) SET n = $props RETURN properties(n) AS p`, params: { props } };
}
