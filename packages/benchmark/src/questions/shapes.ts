// The question shapes a generated question set is built from (S8-003; S8 shared notes, "Question
// kinds and scores"): each starts at one named record and follows one link type (`single_hop`) or
// two (`multi_hop`), along `LINK_TYPES`' directions or back against them. A question's expected
// records are the records at the end of its last step. `no_answer` questions use the same shapes
// about a made-up name; `injection_trap` questions use them about facts their document states.
// `framework` questions are never generated: the generated world has no framework links.
import type { RecordKind } from '@grc/shared';
import type { LinkStep } from './org-graph.js';

export interface QuestionShape {
  /** A stable name for the shape, for example `asset_exposed_to`. */
  id: string;
  kind: 'single_hop' | 'multi_hop';
  /** The kind of the named record the question starts at. */
  start: RecordKind;
  steps: readonly LinkStep[];
  /** The question about the named record. */
  text(name: string): string;
}

const out = (...types: LinkStep['types']): LinkStep => ({ types, direction: 'out' });
const back = (...types: LinkStep['types']): LinkStep => ({ types, direction: 'in' });

export const SINGLE_HOP_SHAPES: readonly QuestionShape[] = [
  {
    id: 'asset_exposed_to',
    kind: 'single_hop',
    start: 'asset',
    steps: [out('EXPOSED_TO')],
    text: (n) => `Which risks is ${n} exposed to?`,
  },
  {
    id: 'risk_mitigated_by',
    kind: 'single_hop',
    start: 'risk',
    steps: [out('MITIGATED_BY')],
    text: (n) => `Which controls mitigate ${n}?`,
  },
  {
    id: 'control_governed_by',
    kind: 'single_hop',
    start: 'control',
    steps: [out('GOVERNED_BY')],
    text: (n) => `Which policy governs ${n}?`,
  },
  {
    id: 'incident_impacts',
    kind: 'single_hop',
    start: 'incident',
    steps: [out('IMPACTS')],
    text: (n) => `Which assets did ${n} impact?`,
  },
  {
    id: 'incident_exposes',
    kind: 'single_hop',
    start: 'incident',
    steps: [out('EXPOSES')],
    text: (n) => `Which risks did ${n} expose?`,
  },
  {
    id: 'asset_hosts_runs',
    kind: 'single_hop',
    start: 'asset',
    steps: [out('HOSTS', 'RUNS')],
    text: (n) => `What does ${n} host or run?`,
  },
  {
    id: 'risk_exposed_assets',
    kind: 'single_hop',
    start: 'risk',
    steps: [back('EXPOSED_TO')],
    text: (n) => `Which assets are exposed to ${n}?`,
  },
  {
    id: 'control_mitigates',
    kind: 'single_hop',
    start: 'control',
    steps: [back('MITIGATED_BY')],
    text: (n) => `Which risks does ${n} mitigate?`,
  },
  {
    id: 'policy_governs',
    kind: 'single_hop',
    start: 'policy',
    steps: [back('GOVERNED_BY')],
    text: (n) => `Which controls does ${n} govern?`,
  },
  {
    id: 'asset_impacted_by',
    kind: 'single_hop',
    start: 'asset',
    steps: [back('IMPACTS')],
    text: (n) => `Which incidents impacted ${n}?`,
  },
  {
    id: 'risk_exposed_by',
    kind: 'single_hop',
    start: 'risk',
    steps: [back('EXPOSES')],
    text: (n) => `Which incidents exposed ${n}?`,
  },
  {
    id: 'asset_hosted_by',
    kind: 'single_hop',
    start: 'asset',
    steps: [back('HOSTS', 'RUNS')],
    text: (n) => `What hosts or runs ${n}?`,
  },
];

export const MULTI_HOP_SHAPES: readonly QuestionShape[] = [
  {
    id: 'asset_risks_controls',
    kind: 'multi_hop',
    start: 'asset',
    steps: [out('EXPOSED_TO'), out('MITIGATED_BY')],
    text: (n) => `Which controls mitigate the risks that ${n} is exposed to?`,
  },
  {
    id: 'risk_controls_policies',
    kind: 'multi_hop',
    start: 'risk',
    steps: [out('MITIGATED_BY'), out('GOVERNED_BY')],
    text: (n) => `Which policies govern the controls that mitigate ${n}?`,
  },
  {
    id: 'incident_assets_risks',
    kind: 'multi_hop',
    start: 'incident',
    steps: [out('IMPACTS'), out('EXPOSED_TO')],
    text: (n) => `Which risks are the assets impacted by ${n} exposed to?`,
  },
  {
    id: 'incident_risks_controls',
    kind: 'multi_hop',
    start: 'incident',
    steps: [out('EXPOSES'), out('MITIGATED_BY')],
    text: (n) => `Which controls mitigate the risks that ${n} exposed?`,
  },
  {
    id: 'asset_hosted_risks',
    kind: 'multi_hop',
    start: 'asset',
    steps: [out('HOSTS', 'RUNS'), out('EXPOSED_TO')],
    text: (n) => `Which risks are the assets that ${n} hosts or runs exposed to?`,
  },
  {
    id: 'policy_controls_risks',
    kind: 'multi_hop',
    start: 'policy',
    steps: [back('GOVERNED_BY'), back('MITIGATED_BY')],
    text: (n) => `Which risks are mitigated by the controls that ${n} governs?`,
  },
  {
    id: 'control_risks_assets',
    kind: 'multi_hop',
    start: 'control',
    steps: [back('MITIGATED_BY'), back('EXPOSED_TO')],
    text: (n) => `Which assets are exposed to the risks that ${n} mitigates?`,
  },
  {
    id: 'risk_assets_incidents',
    kind: 'multi_hop',
    start: 'risk',
    steps: [back('EXPOSED_TO'), back('IMPACTS')],
    text: (n) => `Which incidents impacted the assets that are exposed to ${n}?`,
  },
];

/** Every shape, single-hop first. */
export const QUESTION_SHAPES: readonly QuestionShape[] = [...SINGLE_HOP_SHAPES, ...MULTI_HOP_SHAPES];
