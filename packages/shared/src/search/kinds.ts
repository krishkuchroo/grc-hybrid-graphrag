// What a search can find in the graph (D67, D73; S6 shared notes, "Path B"): the record kinds of an
// org's database, with the D50 row each is checked against and its Neo4j node label, and the link
// types between them (the spec's seven, plus SATISFIES, MAPS_TO, SUPPORTS and CONCERNS).
import type { RecordType } from '../access/role-table.js';
import { MAPPING_LINK_TYPES } from '../frameworks/frameworks.js';
import { CATALOG_KINDS } from '../frameworks/numbers.js';
import { INTAKE_LINK_TYPES } from '../intake/intake-links.js';
import { INTAKE_RECORD_KINDS } from '../intake/intake-numbers.js';
import { LINK_TYPES } from '../records/links.js';
import { RECORD_KINDS } from '../records/types.js';

/** Every kind of record a search can return. */
export const SEARCH_RECORD_KINDS = [...RECORD_KINDS, ...CATALOG_KINDS, ...INTAKE_RECORD_KINDS] as const;
export type SearchRecordKind = (typeof SEARCH_RECORD_KINDS)[number];

export function isSearchRecordKind(v: unknown): v is SearchRecordKind {
  return typeof v === 'string' && (SEARCH_RECORD_KINDS as readonly string[]).includes(v);
}

/** The D50 row a kind is checked against: frameworks and requirements are Framework mappings. */
export const SEARCH_RECORD_TYPE: Readonly<Record<SearchRecordKind, RecordType>> = Object.freeze({
  asset: 'asset',
  risk: 'risk',
  control: 'control',
  policy: 'policy',
  incident: 'incident',
  framework: 'framework_mapping',
  requirement: 'framework_mapping',
  evidence: 'evidence',
  audit_finding: 'audit_finding',
});

/** Each kind's Neo4j node label. */
export const SEARCH_NODE_LABELS = Object.freeze({
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
  framework: 'Framework',
  requirement: 'Requirement',
  evidence: 'Evidence',
  audit_finding: 'AuditFinding',
} as const satisfies Record<SearchRecordKind, string>);

export type SearchNodeLabel = (typeof SEARCH_NODE_LABELS)[SearchRecordKind];

/** The kind of a Neo4j node label, or `null` for any other label (the audit outbox included). */
export function searchKindOfLabel(label: unknown): SearchRecordKind | null {
  return SEARCH_RECORD_KINDS.find((kind) => SEARCH_NODE_LABELS[kind] === label) ?? null;
}

export type SearchLinkType =
  | (typeof LINK_TYPES)[number]['type']
  | (typeof MAPPING_LINK_TYPES)[number]['type']
  | (typeof INTAKE_LINK_TYPES)[number]['type'];

/** Every link type in an org's graph, each once. */
export const SEARCH_LINK_TYPES = [
  ...new Set<SearchLinkType>([...LINK_TYPES, ...MAPPING_LINK_TYPES, ...INTAKE_LINK_TYPES].map((row) => row.type)),
] as [SearchLinkType, ...SearchLinkType[]];

export function isSearchLinkType(v: unknown): v is SearchLinkType {
  return typeof v === 'string' && (SEARCH_LINK_TYPES as readonly string[]).includes(v);
}
