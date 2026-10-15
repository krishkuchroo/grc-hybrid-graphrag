// The dummy sources (D18): the files real connectors would deliver, written from the answer key, with
// the mess real data has and every planted trap recorded.
export {
  renderSources,
  type DuplicatePlant,
  type FalsePositivePlant,
  type InjectionPlant,
  type Mention,
  type OrgSources,
  type Plants,
  type RenderSourcesOptions,
  type RenderedSources,
  type SourceFile,
  type TypoPlant,
} from './render-sources.js';
export {
  CMDB_SOURCES,
  MAX_ASSET_ROWS_PER_FILE,
  PARENT_SEPARATOR,
  type CmdbSource,
  type DuplicateVariant,
} from './cmdb.js';
export { DEFAULT_RATES, type Fact, type MessRates } from './mess.js';
export { INJECTION_KINDS, type InjectionKind } from './injections.js';
export { POLICY_SOURCE } from './policies.js';
export { SOC_SOURCES } from './soc-tickets.js';
export { AUDIT_SOURCE, FINDINGS_PER_REPORT } from './audit-reports.js';
