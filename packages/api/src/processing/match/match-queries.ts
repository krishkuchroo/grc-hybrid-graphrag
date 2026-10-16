// Duplicate matching's Cypher (S4-007; D43, D70, D73). Every query reads one record kind and only
// its active records whose label is in the reader's labels (and, for an "own" cell, only the
// reader's own records); the record left out of a duplicate check is never its own match. Names
// put into the Cypher text come from fixed lists (NODE_LABELS, the index names); every value goes
// in as a parameter. A query never names a database (D144).
import neo4j from 'neo4j-driver';
import { NODE_LABELS, isLabel, type Label, type RecordKind } from '@grc/shared';
import { FULLTEXT_HITS, VECTOR_NEIGHBOURS, type ScoredName, type StoredName } from './match-rules.js';

/** The full-text index over every record label's `name` and `sourceIds` (org-schema.ts). */
export const RECORD_NAMES_INDEX = 'record_names';

/** The label's vector index on `nameEmbedding` (org-schema.ts): `asset_name_embedding` … */
export function nameEmbeddingIndex(kind: RecordKind): string {
  return `${kind}_name_embedding`;
}

/** Whose records a query may return: the labels, the reader's own records only, one left out. */
export interface KindScope {
  kind: RecordKind;
  visible: readonly Label[];
  /** For an "own" cell (a Control Owner's controls): only records this user owns. */
  ownerOnly?: string;
  /** The record a duplicate check is for, never its own match. */
  excludeId?: string;
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

function scopeWhere(v: string, scope: KindScope, params: Record<string, unknown>): string {
  params['visible'] = [...scope.visible];
  const where = [`${v}:${NODE_LABELS[scope.kind]}`, `${v}.status = 'active'`, `${v}.sensitivity IN $visible`];
  if (scope.ownerOnly !== undefined) {
    params['self'] = scope.ownerOnly;
    where.push(`${v}.owner = $self`);
  }
  if (scope.excludeId !== undefined) {
    params['exclude'] = scope.excludeId;
    where.push(`${v}.id <> $exclude`);
  }
  return where.join(' AND ');
}

const FIELDS = (v: string): string =>
  `${v}.id AS id, ${v}.number AS number, ${v}.name AS name, ${v}.sensitivity AS label, ` +
  `${v}.sourceIds AS sourceIds, ${v}.version AS version`;

/** Every record of the scope: the exact step compares their names, numbers and source IDs. */
export function scanQuery(scope: KindScope): BuiltQuery {
  const params: Record<string, unknown> = {};
  const where = scopeWhere('n', scope, params);
  return { text: `MATCH (n:${NODE_LABELS[scope.kind]}) WHERE ${where} RETURN ${FIELDS('n')}`, params };
}

/** The scope's records the full-text index finds for a Lucene query, best first (the spelling step). */
export function fullTextQueryOf(scope: KindScope, lucene: string): BuiltQuery {
  const params: Record<string, unknown> = { q: lucene, limit: neo4j.int(FULLTEXT_HITS) };
  const where = scopeWhere('node', scope, params);
  return {
    text:
      `CALL db.index.fulltext.queryNodes('${RECORD_NAMES_INDEX}', $q) YIELD node, score ` +
      `WHERE ${where} RETURN ${FIELDS('node')} LIMIT $limit`,
    params,
  };
}

/** The scope's records nearest a name's vector in the label's vector index (the meaning step). */
export function vectorQueryOf(scope: KindScope, vector: readonly number[]): BuiltQuery {
  const params: Record<string, unknown> = {
    index: nameEmbeddingIndex(scope.kind),
    k: neo4j.int(VECTOR_NEIGHBOURS),
    vector: [...vector],
  };
  const where = scopeWhere('node', scope, params);
  return {
    text:
      'CALL db.index.vector.queryNodes($index, $k, $vector) YIELD node, score ' +
      `WHERE ${where} RETURN ${FIELDS('node')}, score ORDER BY score DESC`,
    params,
  };
}

/** A row as a stored name, or null when it lacks what every record has (an ID, number and label). */
export function toStoredName(row: { get(key: string): unknown }): StoredName | null {
  const id = row.get('id');
  const number = row.get('number');
  const label = row.get('label');
  if (typeof id !== 'string' || typeof number !== 'string' || !isLabel(label)) return null;
  const name = row.get('name');
  const sourceIds = row.get('sourceIds');
  const version = Number(row.get('version'));
  return {
    id,
    number,
    name: typeof name === 'string' ? name : '',
    label,
    sourceIds: Array.isArray(sourceIds) ? sourceIds.filter((s): s is string => typeof s === 'string') : [],
    version: Number.isInteger(version) ? version : 0,
  };
}

/** A vector query row as a scored name. */
export function toScoredName(row: { get(key: string): unknown }): ScoredName | null {
  const record = toStoredName(row);
  const score = Number(row.get('score'));
  return record && Number.isFinite(score) ? { record, score } : null;
}
