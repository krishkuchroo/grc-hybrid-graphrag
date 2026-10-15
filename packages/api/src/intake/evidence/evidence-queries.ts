// The evidence Cypher (S3-009): the list query with its filters and sort (D47), one evidence item,
// the evidence supporting one control, and the writes. Every name put into the Cypher text comes
// from the fixed lists below; every value the caller sends goes in as a parameter.
// - Evidence is visible when its label is at or below the caller's clearance (D51) and the role may
//   view evidence (D50). For the Control Owner (`upload_own`, D213 (3)) it must also support a
//   control they own whose label they can see: `EvidenceScope.evidenceOwnerOnly`.
// - The controls an item supports show only when the reader can see them: a visible label, and for
//   a role whose Control cell is `edit_own` only their own (`EvidenceScope.controlOwnerOnly`).
// - `validity` follows `evidenceValidity` (S3-002): no valid-until date is `valid`, a date before
//   today `expired`, today up to EXPIRING_SOON_DAYS ahead `expiring`. Dates are stored as
//   `YYYY-MM-DD` text, so comparing them as text compares the days.
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import {
  EVIDENCE_REVIEW_STATUSES,
  EVIDENCE_VALIDITIES,
  EXPIRING_SOON_DAYS,
  INTAKE_NODE_LABELS,
  LABELS,
  NODE_LABELS,
  type EvidenceValidity,
  type Label,
} from '@grc/shared';
import { pageQuerySchema } from '../../common/paging.js';
import { visibleLabels } from '../../records/record-queries.js';
import { addDays } from '../audit-findings/finding-queries.js';

/** The evidence node label (D67). */
export const EVIDENCE_LABEL = INTAKE_NODE_LABELS.evidence;

/** The one link type evidence has (D67): Evidence -SUPPORTS-> Control. */
export const SUPPORTS = 'SUPPORTS';

const CONTROL_LABEL = NODE_LABELS.control;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a value is a lowercase UUID, the form every record ID has. */
export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export const recordIdSchema = z.string().regex(UUID, 'must be a lowercase UUID');

export const EVIDENCE_SORT_FIELDS = ['number', 'name', 'collectedDate', 'validUntil'] as const;
type SortField = (typeof EVIDENCE_SORT_FIELDS)[number];
const SORT_VALUES = EVIDENCE_SORT_FIELDS.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];

const statusFilter = z.enum(['active', 'retired', 'all']).default('active');

export const evidenceListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  sort: z.enum(SORT_VALUES).default('number'),
  status: statusFilter,
  controlId: recordIdSchema.optional(),
  label: z.enum(LABELS).optional(),
  reviewStatus: z.enum(EVIDENCE_REVIEW_STATUSES).optional(),
  validity: z.enum(EVIDENCE_VALIDITIES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export type EvidenceListQuery = z.infer<typeof evidenceListQuerySchema>;

/** Checks a list query. Unknown filters and sort fields are refused (a ZodError, answered as 400). */
export function parseEvidenceListQuery(query: unknown): EvidenceListQuery {
  return evidenceListQuerySchema.parse(query ?? {});
}

/** The query of the evidence supporting one control: only the record status. */
export const controlEvidenceQuerySchema = z.strictObject({ status: statusFilter });

export type ControlEvidenceQuery = z.infer<typeof controlEvidenceQuerySchema>;

export function parseControlEvidenceQuery(query: unknown): ControlEvidenceQuery {
  return controlEvidenceQuerySchema.parse(query ?? {});
}

/** Who is reading evidence. */
export interface EvidenceScope {
  clearance: Label;
  /** Evidence only when it supports a visible control this user owns (the `upload_own` cell). */
  evidenceOwnerOnly?: string;
  /** Controls only when this user owns them (an `edit_own` Control cell). */
  controlOwnerOnly?: string;
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

function scopeParams(scope: EvidenceScope): Record<string, unknown> {
  const params: Record<string, unknown> = { visible: visibleLabels(scope.clearance) };
  if (scope.evidenceOwnerOnly !== undefined) params['evidenceSelf'] = scope.evidenceOwnerOnly;
  if (scope.controlOwnerOnly !== undefined) params['controlSelf'] = scope.controlOwnerOnly;
  return params;
}

/** The condition on a control node `v` that the scope lets the reader see. */
function controlWhere(v: string, scope: EvidenceScope): string {
  const parts = [`${v}.sensitivity IN $visible`];
  if (scope.controlOwnerOnly !== undefined) parts.push(`${v}.owner = $controlSelf`);
  return parts.join(' AND ');
}

/** The conditions on an evidence node `e` that the scope lets the reader see. */
function evidenceWhere(scope: EvidenceScope): string[] {
  const where = ['e.sensitivity IN $visible'];
  if (scope.evidenceOwnerOnly !== undefined) {
    where.push(
      `EXISTS { MATCH (e)-[:${SUPPORTS}]->(oc:${CONTROL_LABEL}) WHERE oc.sensitivity IN $visible AND oc.owner = $evidenceSelf }`,
    );
  }
  return where;
}

/** The controls an evidence node `e` supports that the scope lets the reader see, as `controls`. */
function withControls(scope: EvidenceScope): string {
  return `OPTIONAL MATCH (e)-[:${SUPPORTS}]->(c:${CONTROL_LABEL}) WHERE ${controlWhere('c', scope)}
     WITH e, collect(c { .id, .number, .name, .sensitivity, .owner, .status }) AS controls`;
}

/** The `validity` filter as a Cypher condition on `e`, around `today`. */
export function validityWhere(validity: EvidenceValidity, today: string, params: Record<string, unknown>): string {
  params['today'] = today;
  params['expiringEnd'] = addDays(today, EXPIRING_SOON_DAYS);
  if (validity === 'expired') return '(e.validUntil IS NOT NULL AND e.validUntil < $today)';
  if (validity === 'expiring') return '(e.validUntil >= $today AND e.validUntil <= $expiringEnd)';
  return '(e.validUntil IS NULL OR e.validUntil > $expiringEnd)';
}

const SORT_EXPR: Record<SortField, string> = {
  number: 'e.number',
  name: 'e.name',
  collectedDate: 'e.collectedDate',
  validUntil: 'e.validUntil',
};

function orderBy(sort: string): string {
  const descending = sort.startsWith('-');
  const field = (descending ? sort.slice(1) : sort) as SortField;
  const dir = descending ? 'DESC' : 'ASC';
  return field === 'number' ? `e.number ${dir}` : `${SORT_EXPR[field]} ${dir}, e.number ${dir}`;
}

/** The count and page queries for a checked list query; `today` is needed for `validity`. */
export function evidenceListQueries(
  q: EvidenceListQuery,
  scope: EvidenceScope,
  today: string,
): { count: BuiltQuery; page: BuiltQuery } {
  const params = scopeParams(scope);
  const where = evidenceWhere(scope);
  if (q.status !== 'all') {
    params['status'] = q.status;
    where.push('e.status = $status');
  }
  if (q.controlId !== undefined) {
    params['controlId'] = q.controlId;
    where.push(
      `EXISTS { MATCH (e)-[:${SUPPORTS}]->(fc:${CONTROL_LABEL} {id: $controlId}) WHERE ${controlWhere('fc', scope)} }`,
    );
  }
  if (q.label !== undefined) {
    params['label'] = q.label;
    where.push('e.sensitivity = $label');
  }
  if (q.reviewStatus !== undefined) {
    params['reviewStatus'] = q.reviewStatus;
    where.push('e.reviewStatus = $reviewStatus');
  }
  if (q.validity !== undefined) where.push(validityWhere(q.validity, today, params));
  if (q.q !== undefined) {
    params['q'] = q.q.toLowerCase();
    where.push('(toLower(e.name) CONTAINS $q OR toLower(e.number) CONTAINS $q)');
  }
  const match = `MATCH (e:${EVIDENCE_LABEL}) WHERE ${where.join(' AND ')}`;
  const order = orderBy(q.sort);
  return {
    count: { text: `${match} RETURN count(e) AS total`, params },
    page: {
      text: `${match}
     WITH e ORDER BY ${order} SKIP $skip LIMIT $limit
     ${withControls(scope)}
     RETURN properties(e) AS p, controls ORDER BY ${order}`,
      params: { ...params, skip: neo4j.int((q.page - 1) * q.pageSize), limit: neo4j.int(q.pageSize) },
    },
  };
}

/** One evidence item by ID, if the scope lets the reader see it, with its visible controls. */
export function evidenceGetQuery(id: string, scope: EvidenceScope): BuiltQuery {
  return {
    text: `MATCH (e:${EVIDENCE_LABEL} {id: $id}) WHERE ${evidenceWhere(scope).join(' AND ')}
     ${withControls(scope)}
     RETURN properties(e) AS p, controls`,
    params: { ...scopeParams(scope), id },
  };
}

/** A control by ID, if the scope lets the reader see it. */
export function controlGetQuery(id: string, scope: EvidenceScope): BuiltQuery {
  return {
    text: `MATCH (c:${CONTROL_LABEL} {id: $id}) WHERE ${controlWhere('c', scope)} RETURN properties(c) AS p`,
    params: { ...scopeParams(scope), id },
  };
}

/** The visible evidence supporting one control (found through `controlGetQuery` first). */
export function controlEvidenceQuery(
  controlId: string,
  scope: EvidenceScope,
  status: ControlEvidenceQuery['status'],
): BuiltQuery {
  const params: Record<string, unknown> = { ...scopeParams(scope), controlId };
  const where = evidenceWhere(scope);
  if (status !== 'all') {
    params['status'] = status;
    where.push('e.status = $status');
  }
  return {
    text: `MATCH (e:${EVIDENCE_LABEL})-[:${SUPPORTS}]->(:${CONTROL_LABEL} {id: $controlId})
     WHERE ${where.join(' AND ')}
     WITH DISTINCT e
     ${withControls(scope)}
     RETURN properties(e) AS p, controls ORDER BY e.number`,
    params,
  };
}

/** Write-locks an evidence node for the rest of this transaction (a property set and removed
 * again, so the node is unchanged): its version is read after any other writer's. */
export function lockEvidenceQuery(id: string): BuiltQuery {
  return { text: `MATCH (e:${EVIDENCE_LABEL} {id: $id}) SET e.__lock = true REMOVE e.__lock`, params: { id } };
}

/** Write-locks a control the same way, so two adds of the same file to it run one after the other. */
export function lockControlQuery(id: string): BuiltQuery {
  return { text: `MATCH (c:${CONTROL_LABEL} {id: $id}) SET c.__lock = true REMOVE c.__lock`, params: { id } };
}

/** The evidence's stored properties and every control it supports, read by the writer. */
export function evidenceForWriteQuery(id: string): BuiltQuery {
  return {
    text: `MATCH (e:${EVIDENCE_LABEL} {id: $id})
     OPTIONAL MATCH (e)-[:${SUPPORTS}]->(c:${CONTROL_LABEL})
     WITH e, collect(c { .id, .number, .name, .sensitivity, .owner, .status }) AS controls
     RETURN properties(e) AS p, controls`,
    params: { id },
  };
}

/** A control's stored properties, read by the writer. */
export function controlForWriteQuery(id: string): BuiltQuery {
  return { text: `MATCH (c:${CONTROL_LABEL} {id: $id}) RETURN properties(c) AS p`, params: { id } };
}

/** How many active evidence items with this file support this control, whoever can see them. */
export function attachedCountQuery(controlId: string, fileHash: string): BuiltQuery {
  return {
    text: `MATCH (e:${EVIDENCE_LABEL} {fileHash: $fileHash})-[:${SUPPORTS}]->(:${CONTROL_LABEL} {id: $controlId})
     WHERE e.status = 'active'
     RETURN count(e) AS n`,
    params: { controlId, fileHash },
  };
}

/** Creates the evidence and its SUPPORTS link (origin `manual`) together; no row when the control
 * is gone. */
export function createEvidenceQuery(
  controlId: string,
  props: Record<string, unknown>,
  link: { createdAt: string; createdBy: string },
): BuiltQuery {
  return {
    text: `MATCH (c:${CONTROL_LABEL} {id: $controlId})
     CREATE (e:${EVIDENCE_LABEL})
     SET e = $props
     CREATE (e)-[r:${SUPPORTS}]->(c)
     SET r.createdAt = $createdAt, r.createdBy = $createdBy, r.origin = 'manual'
     RETURN properties(e) AS p`,
    params: { controlId, props, createdAt: link.createdAt, createdBy: link.createdBy },
  };
}

/** Sets the changed properties. A `null` value removes the property. */
export function saveEvidenceQuery(id: string, props: Record<string, unknown>): BuiltQuery {
  return {
    text: `MATCH (e:${EVIDENCE_LABEL} {id: $id}) SET e += $props RETURN properties(e) AS p`,
    params: { id, props },
  };
}
