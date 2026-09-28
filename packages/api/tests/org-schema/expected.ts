// The D73 graph schema every org database carries (S1-002). Test writer's file (D89, D96).
//
// Contract these tests hold the code to (TASKS.md, brief S1-002):
// - `src/graph/org-schema.ts` exports
//     `orgSchemaStatements(): string[]`  pure; every statement, in order. Each one is a
//        `CREATE … <name> IF NOT EXISTS …` schema command, and none names a database (no USE, D144).
//     `ensureOrgSchema(graph, orgId): Promise<void>`  runs them in `org-<orgId>` as grc_admin or
//        grc_writer, through the M0-004 GraphService (`graph`). When it resolves, every index is
//        ONLINE. Running it again changes nothing and throws nothing (D45.5).
// - `provisionOrg` (M0-014) calls `ensureOrgSchema` right after `createOrgDatabase`.
//
// The fixed names (brief item 6, "fixed and readable, for example `asset_id_unique`"). Each label's
// name part is its snake_case form: Asset → asset, AuditFinding → audit_finding.
//   <label>_id_unique, <label>_number_unique   uniqueness constraints on `id` and `number`
//   <label>_status, <label>_sensitivity, <label>_owner   range indexes (D73 lookups; the label
//                                              the query accounts filter on is `sensitivity`)
//   asset_asset_type, control_framework, requirement_framework   range indexes
//   record_names                               one full-text index on `name` and `sourceIds`, all
//                                              nine labels (D70)
//   <label>_name_embedding                     vector index on `nameEmbedding`, 1024 dims, cosine
//                                              (D70, D71)
//   <link>_source_doc                          relationship range index on `sourceDocId`, per link
//                                              type (HOSTS → hosts_source_doc)

/** The nine record labels, as in NODE_RECORD_TYPES (packages/api/src/graph/privileges.ts). */
export const RECORD_LABELS = [
  'Asset',
  'Risk',
  'Control',
  'Policy',
  'Incident',
  'Framework',
  'Requirement',
  'Evidence',
  'AuditFinding',
] as const;
export type RecordLabel = (typeof RECORD_LABELS)[number];

/** The link types the brief lists, each with its own `sourceDocId` index. */
export const LINK_TYPES = [
  'HOSTS',
  'RUNS',
  'EXPOSED_TO',
  'MITIGATED_BY',
  'GOVERNED_BY',
  'IMPACTS',
  'EXPOSES',
  'SATISFIES',
  'MAPS_TO',
  'SUPPORTS',
  'CONCERNS',
] as const;

export const FULLTEXT_INDEX = 'record_names';
export const VECTOR_DIMENSIONS = 1024;

/** Asset → asset, AuditFinding → audit_finding. */
export function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export interface ConstraintSpec {
  name: string;
  label: RecordLabel;
  property: 'id' | 'number';
}
export interface RangeSpec {
  name: string;
  entity: 'NODE' | 'RELATIONSHIP';
  labelOrType: string;
  property: string;
}
export interface VectorSpec {
  name: string;
  label: RecordLabel;
}

export const CONSTRAINTS: ConstraintSpec[] = RECORD_LABELS.flatMap((label) =>
  (['id', 'number'] as const).map((property) => ({ name: `${snake(label)}_${property}_unique`, label, property })),
);

export const NODE_RANGE_INDEXES: RangeSpec[] = [
  ...RECORD_LABELS.flatMap((label) =>
    ['status', 'sensitivity', 'owner'].map((property) => ({
      name: `${snake(label)}_${property}`,
      entity: 'NODE' as const,
      labelOrType: label,
      property,
    })),
  ),
  { name: 'asset_asset_type', entity: 'NODE', labelOrType: 'Asset', property: 'assetType' },
  { name: 'control_framework', entity: 'NODE', labelOrType: 'Control', property: 'framework' },
  { name: 'requirement_framework', entity: 'NODE', labelOrType: 'Requirement', property: 'framework' },
];

export const LINK_INDEXES: RangeSpec[] = LINK_TYPES.map((type) => ({
  name: `${type.toLowerCase()}_source_doc`,
  entity: 'RELATIONSHIP',
  labelOrType: type,
  property: 'sourceDocId',
}));

export const VECTOR_INDEXES: VectorSpec[] = RECORD_LABELS.map((label) => ({
  name: `${snake(label)}_name_embedding`,
  label,
}));

/**
 * Every schema name: one statement creates each. In SHOW INDEXES, a uniqueness constraint's own
 * index carries the constraint's name, so this is also every index name.
 */
export const ALL_SCHEMA_NAMES: string[] = [
  ...CONSTRAINTS.map((c) => c.name),
  ...NODE_RANGE_INDEXES.map((i) => i.name),
  FULLTEXT_INDEX,
  ...VECTOR_INDEXES.map((i) => i.name),
  ...LINK_INDEXES.map((i) => i.name),
];
