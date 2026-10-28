// The correct graph query of each generated question (EV-001 behaviour 7; D261 track A, item 2):
// one read-only query per question from a fixed pattern per fine kind, with the labels and link
// directions of the org's graph (`SEARCH_NODE_LABELS`, `LINK_TYPES`, `MAPPING_LINK_TYPES`, as the
// api's `graph-description.ts` describes them). Names are inlined as single-quoted Cypher strings,
// with `\` and `'` escaped; there is no `$` parameter. Each query returns `RETURN DISTINCT` of the
// target nodes only. `pnpm eval:questions` checks each one with the api's `checkGraphQuery`, and
// `pnpm bench:run` runs them (EV-002). Pure: no I/O.
import {
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  SEARCH_LIMITS,
  SEARCH_NODE_LABELS,
  type SearchLinkType,
  type SearchRecordKind,
} from '@grc/shared';

/** The longest gold query: the graph path's own limit. */
export const MAX_GOLD_QUERY_LENGTH = SEARCH_LIMITS.graphQueryMaxLength;

/** A name as a single-quoted Cypher string: `\` and `'` escaped. */
export function cypherString(name: string): string {
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const ROWS: readonly { type: SearchLinkType; from: SearchRecordKind; to: SearchRecordKind }[] = [
  ...LINK_TYPES,
  ...MAPPING_LINK_TYPES,
];

/** One link step from a node of `from` to one of `to`; refused unless the graph has that link. */
function link(type: SearchLinkType, from: SearchRecordKind, to: SearchRecordKind): string {
  if (!ROWS.some((row) => row.type === type && row.from === from && row.to === to)) {
    throw new Error(`no ${type} link from ${from} to ${to}`);
  }
  return `-[:${type}]->`;
}

function label(kind: SearchRecordKind): string {
  return SEARCH_NODE_LABELS[kind];
}

/** A named node: `(:Label {name: '…'})`. */
function named(kind: SearchRecordKind, name: string): string {
  return `(:${label(kind)} {name: ${cypherString(name)}})`;
}

/** Risk → its MITIGATED_BY controls. */
export function mitigatedByQuery(riskName: string): string {
  return `MATCH ${named('risk', riskName)}${link('MITIGATED_BY', 'risk', 'control')}(c:${label('control')}) RETURN DISTINCT c`;
}

/** Asset → the incidents with IMPACTS to it. */
export function impactsQuery(assetName: string): string {
  return `MATCH (i:${label('incident')})${link('IMPACTS', 'incident', 'asset')}${named('asset', assetName)} RETURN DISTINCT i`;
}

/** Policy → the controls GOVERNED_BY it. */
export function governsQuery(policyName: string): string {
  return `MATCH (c:${label('control')})${link('GOVERNED_BY', 'control', 'policy')}${named('policy', policyName)} RETURN DISTINCT c`;
}

/** Asset → its EXPOSED_TO risks (the injection questions and the made-up asset's). */
export function exposedToQuery(assetName: string): string {
  return `MATCH ${named('asset', assetName)}${link('EXPOSED_TO', 'asset', 'risk')}(r:${label('risk')}) RETURN DISTINCT r`;
}

/** The two-step shapes: the start's kind, and both links. */
export const TWO_STEP_SHAPES = ['asset', 'incident', 'risk'] as const;
export type TwoStepShape = (typeof TWO_STEP_SHAPES)[number];

/**
 * The two-step query: asset → EXPOSED_TO risks → MITIGATED_BY controls; incident → EXPOSES risks →
 * MITIGATED_BY controls; risk → MITIGATED_BY controls → GOVERNED_BY policies.
 */
export function twoStepQuery(shape: TwoStepShape, startName: string): string {
  switch (shape) {
    case 'asset':
      return `MATCH ${named('asset', startName)}${link('EXPOSED_TO', 'asset', 'risk')}(:${label('risk')})${link('MITIGATED_BY', 'risk', 'control')}(c:${label('control')}) RETURN DISTINCT c`;
    case 'incident':
      return `MATCH ${named('incident', startName)}${link('EXPOSES', 'incident', 'risk')}(:${label('risk')})${link('MITIGATED_BY', 'risk', 'control')}(c:${label('control')}) RETURN DISTINCT c`;
    case 'risk':
      return `MATCH ${named('risk', startName)}${link('MITIGATED_BY', 'risk', 'control')}(:${label('control')})${link('GOVERNED_BY', 'control', 'policy')}(p:${label('policy')}) RETURN DISTINCT p`;
  }
}

/**
 * Control → the requirements it SATISFIES plus those MAPS_TO reaches from them, either way. The
 * catalogs store NIST's crosswalks as CSF 2.0 → 800-53 and 800-53 → ISO 27001
 * (`frameworks/catalog-loader.ts`: the citing requirement to the cited one), so from an 800-53
 * requirement the CSF ones are reached against the link and the ISO ones along it: exactly
 * `framework-mappings.json`'s `alsoReachedThroughNistCrosswalks`.
 */
export function frameworkQuery(controlName: string): string {
  const req = label('requirement');
  return (
    `MATCH ${named('control', controlName)}${link('SATISFIES', 'control', 'requirement')}(r:${req}) ` +
    `OPTIONAL MATCH (r)-[:MAPS_TO]-(x:${req}) ` +
    'WITH collect(DISTINCT r) + collect(DISTINCT x) AS rs UNWIND rs AS req RETURN DISTINCT req'
  );
}
