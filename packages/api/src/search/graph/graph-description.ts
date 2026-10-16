// The graph as the graph-query prompt describes it to one role (S6-004, behaviour 2; D50, D67, D73):
// the node labels the role views, each with its properties as stored, and the links between them
// with their directions. A role sees only its own part: a kind it doesn't view is never named, and
// neither is a link with an end of such a kind, so the prompt holds nothing the role couldn't
// query anyway (D52.1). The rule is the one the role's read-only accounts are built on
// (`graph/privileges.ts`): `can(role, type, 'view')`, so an "own" cell (a Control Owner's controls)
// counts as not viewed, as it does for the account.
//
// The same table gives each kind's key fields: what Path B keeps of a record besides its ID,
// number, name, kind, label and status (behaviour 5). Long texts (descriptions, root causes),
// owners, audit fields, `sourceIds` and `nameEmbedding` are never key fields.
import {
  ASSET_TYPES,
  CONTROL_STATUSES,
  CRITICALITIES,
  EVIDENCE_REVIEW_STATUSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FRAMEWORKS,
  FRAMEWORK_KEYS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INTAKE_LINK_TYPES,
  LABELS,
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  RECORD_ORIGINS,
  SEARCH_NODE_LABELS,
  SEARCH_RECORD_KINDS,
  SEARCH_RECORD_TYPE,
  can,
  type Role,
  type SearchLinkType,
  type SearchRecordKind,
} from '@grc/shared';

/** One stored property a query may use, with what it holds. */
export interface GraphField {
  name: string;
  about: string;
}

function oneOf(values: readonly (string | number)[]): string {
  return `one of ${values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')}`;
}

const DATE = "a date as text, 'YYYY-MM-DD'";
const DATE_OR_NULL = "a date as text, 'YYYY-MM-DD', or null";

/** Each kind's own fields, as stored: the key fields of Path B's records (behaviour 5). */
export const GRAPH_KIND_FIELDS: Readonly<Record<SearchRecordKind, readonly GraphField[]>> = Object.freeze({
  asset: [
    { name: 'assetType', about: oneOf(ASSET_TYPES) },
    { name: 'criticality', about: oneOf(CRITICALITIES) },
    { name: 'dataClassification', about: `the label of the data it holds, ${oneOf(LABELS)}` },
  ],
  risk: [
    { name: 'impact', about: 'a whole number from 1 (lowest) to 5 (highest)' },
    { name: 'likelihood', about: 'a whole number from 1 (lowest) to 5 (highest)' },
    { name: 'financialExposure', about: 'a whole number of US dollars' },
  ],
  control: [
    { name: 'code', about: "the control's code, for example 'IA-2'" },
    { name: 'framework', about: "the framework it follows, as plain text, for example 'NIST 800-53'" },
    { name: 'controlStatus', about: oneOf(CONTROL_STATUSES) },
    { name: 'lastTestedDate', about: DATE },
  ],
  policy: [
    { name: 'policyVersion', about: "the policy's own version, as text" },
    { name: 'effectiveDate', about: DATE },
  ],
  incident: [
    { name: 'severity', about: oneOf(INCIDENT_SEVERITIES) },
    { name: 'incidentStatus', about: oneOf(INCIDENT_STATUSES) },
    { name: 'occurredAt', about: "a date and time as text, 'YYYY-MM-DDTHH:MM:SSZ'" },
  ],
  framework: [
    {
      name: 'key',
      about: `${oneOf(FRAMEWORK_KEYS)} (${FRAMEWORK_KEYS.map((k) => `'${k}' is ${FRAMEWORKS[k].name}`).join(', ')})`,
    },
    { name: 'frameworkVersion', about: "the framework's own edition, as text" },
    { name: 'publisher', about: 'who publishes it, as text' },
  ],
  requirement: [
    { name: 'code', about: "its code in its framework, for example 'AC-2', 'PR.AA-03', 'A.8.5' or 'CC6.1'" },
    { name: 'title', about: 'its title' },
    { name: 'framework', about: `the key of its framework, ${oneOf(FRAMEWORK_KEYS)}` },
    { name: 'group', about: "the code of its group in the framework, for example 'AC', 'PR.AA', 'A.8' or 'CC6'" },
  ],
  evidence: [
    { name: 'collectedDate', about: DATE },
    { name: 'validUntil', about: DATE_OR_NULL },
    { name: 'reviewStatus', about: oneOf(EVIDENCE_REVIEW_STATUSES) },
    { name: 'fileName', about: 'the name of its file' },
  ],
  audit_finding: [
    { name: 'severity', about: oneOf(FINDING_SEVERITIES) },
    { name: 'findingStatus', about: oneOf(FINDING_STATUSES) },
    { name: 'sourceReference', about: "the audit's own reference for it" },
    { name: 'identifiedDate', about: DATE },
    { name: 'dueDate', about: DATE },
    { name: 'closedDate', about: DATE_OR_NULL },
  ],
});

/** One link type in one direction, from one kind to another, with what it means. */
export interface GraphLinkRow {
  type: SearchLinkType;
  from: SearchRecordKind;
  to: SearchRecordKind;
  meaning: string;
}

const MEANINGS: Readonly<Record<string, string>> = {
  'HOSTS:asset:asset': 'the first asset hosts the second',
  'RUNS:asset:asset': 'the second asset runs on the first',
  'EXPOSED_TO:asset:risk': 'the asset is exposed to the risk',
  'MITIGATED_BY:risk:control': 'the risk is mitigated by the control',
  'GOVERNED_BY:control:policy': 'the control is governed by the policy',
  'IMPACTS:incident:asset': 'the incident impacted the asset',
  'EXPOSES:incident:risk': 'the incident exposes the risk',
  'SATISFIES:control:requirement': 'the control satisfies the framework requirement',
  'MAPS_TO:requirement:requirement': "the first requirement maps to the second, another framework's",
  'SUPPORTS:evidence:control': 'the evidence shows the control works',
  'CONCERNS:audit_finding:control': 'the audit finding concerns the control',
  'CONCERNS:audit_finding:risk': 'the audit finding concerns the risk',
};

/** Every link row of an org's graph: the spec's seven, then SATISFIES, MAPS_TO, SUPPORTS and CONCERNS. */
export const GRAPH_LINK_ROWS: readonly GraphLinkRow[] = Object.freeze(
  [...LINK_TYPES, ...MAPPING_LINK_TYPES, ...INTAKE_LINK_TYPES].map((row) => ({
    type: row.type,
    from: row.from,
    to: row.to,
    meaning: MEANINGS[`${row.type}:${row.from}:${row.to}`] ?? `${row.from} to ${row.to}`,
  })),
);

/** The kinds `role` views, in the shared order. An unknown role views none (fail safe). */
export function viewedKinds(role: Role | string): SearchRecordKind[] {
  return SEARCH_RECORD_KINDS.filter((kind) => can(role, SEARCH_RECORD_TYPE[kind], 'view'));
}

/** The link rows whose two ends are both kinds `role` views. */
export function viewedLinkRows(role: Role | string): GraphLinkRow[] {
  const kinds = new Set(viewedKinds(role));
  return GRAPH_LINK_ROWS.filter((row) => kinds.has(row.from) && kinds.has(row.to));
}

/** The THE GRAPH part of the prompt, for `role` only. */
export function describeGraph(role: Role | string): string {
  const kinds = viewedKinds(role);
  const lines: string[] = [];
  lines.push('Node labels. Every node has these properties:');
  lines.push('- id: its internal ID, a UUID');
  lines.push("- number: its record number, three capital letters and seven digits, for example 'RSK0001014'");
  lines.push('- name: its name');
  lines.push("- status: 'active' or 'retired'");
  lines.push(`- sensitivity: its label, ${oneOf(LABELS)}`);
  lines.push(`- origin: how it was made, ${oneOf(RECORD_ORIGINS)}`);
  lines.push('Each label also has its own properties:');
  for (const kind of kinds) {
    const fields = GRAPH_KIND_FIELDS[kind].map((f) => `${f.name} (${f.about})`).join('; ');
    lines.push(`- ${SEARCH_NODE_LABELS[kind]}: ${fields}`);
  }
  if (kinds.length === 0) lines.push('- (none)');
  lines.push('');
  const rows = viewedLinkRows(role);
  lines.push(
    `Relationship types. Each one goes one way only, from the first node label to the second. Every relationship has the properties origin (${oneOf(RECORD_ORIGINS)}) and createdAt (a date and time as text).`,
  );
  for (const row of rows) {
    lines.push(`- (:${SEARCH_NODE_LABELS[row.from]})-[:${row.type}]->(:${SEARCH_NODE_LABELS[row.to]}): ${row.meaning}`);
  }
  if (rows.length === 0) lines.push('- (none)');
  lines.push('');
  lines.push(
    "Full-text index: 'record_names', over the name of every node label above, for loose name matching. Call it as CALL db.index.fulltext.queryNodes('record_names', 'payroll database') YIELD node, score, then keep the label you want with WHERE node:Asset (or another label). Leave these characters out of the search words: + - && || ! ( ) { } [ ] ^ \" ~ * ? : \\ /",
  );
  return lines.join('\n');
}
