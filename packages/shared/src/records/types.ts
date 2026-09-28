// The five core record types of the spec's ontology (D67, D202): their kinds, API paths and graph labels.
export const RECORD_KINDS = ['asset', 'risk', 'control', 'policy', 'incident'] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === 'string' && (RECORD_KINDS as readonly string[]).includes(value);
}

/** The plural names in the API paths (D47), for example `/api/v1/risks`. */
export const RECORD_PATHS = {
  asset: 'assets',
  risk: 'risks',
  control: 'controls',
  policy: 'policies',
  incident: 'incidents',
} as const satisfies Record<RecordKind, 'assets' | 'risks' | 'controls' | 'policies' | 'incidents'>;

export type RecordPath = (typeof RECORD_PATHS)[RecordKind];

/** The Neo4j node labels. */
export const NODE_LABELS = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
} as const satisfies Record<RecordKind, 'Asset' | 'Risk' | 'Control' | 'Policy' | 'Incident'>;

export type NodeLabel = (typeof NODE_LABELS)[RecordKind];

/** Every record's status: retired, never deleted (D69). */
export const RECORD_STATUSES = ['active', 'retired'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Where a record came from (D68). */
export const RECORD_ORIGINS = ['manual', 'import', 'ai'] as const;
export type RecordOrigin = (typeof RECORD_ORIGINS)[number];
