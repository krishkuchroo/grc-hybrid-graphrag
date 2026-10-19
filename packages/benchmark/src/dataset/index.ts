// A dataset folder in the answer-key format (FT-001; D234, D235, D238 (b)): read and checked whole
// (`pnpm dataset:load` and `pnpm dataset:score` both start here), and an org's ingestion scored
// against its keys. The API key and the databases are the commands' own
// (packages/infra/scripts/dataset-load.ts, dataset-score.ts).
export {
  DATASET_ASSET_LISTS_DIR,
  DATASET_DOCUMENTS_DIR,
  DATASET_FILES,
  DATASET_LINK_ORIGINS,
  DATASET_SOURCES_DIR,
  DatasetFolderError,
  FAST_ORG_SUFFIX,
  MAX_DATASET_JSON_BYTES,
  MAX_DATASET_SLUG_LENGTH,
  NORMALISED_FIELDS,
  datasetProblemLine,
  fastOrgSlugOf,
  readDatasetFolder,
  type DatasetFact,
  type DatasetFolder,
  type DatasetFolderDocument,
  type DatasetFolderProblem,
  type DatasetLinkOrigin,
  type DatasetNormalisationRow,
  type DatasetProvenanceLink,
  type DatasetScannerRow,
} from './folder.js';
export {
  DATASET_SCORE_USAGE,
  checkScoreOrg,
  parseDatasetScoreArgs,
  type DatasetScoreArgs,
  type DatasetScoreArgsResult,
} from './args.js';
export {
  DUPLICATE_STATES,
  FACT_STATES,
  LIVE_LINK_ORIGINS,
  NORMALISATION_STATES,
  scoreDataset,
  type DatasetScore,
  type DatasetSnapshot,
  type DuplicateItem,
  type DuplicateState,
  type ExtraLinkItem,
  type FactItem,
  type FactState,
  type LiveLinkOrigin,
  type NormalisationItem,
  type NormalisationState,
  type RecordMatch,
  type RecordRef,
  type UnmatchedItem,
} from './score.js';
export { datasetScoreOutput, type DatasetScoreOutputContext } from './output.js';
export {
  DATASET_REPORT_VERSION,
  compactUtcTime,
  datasetReport,
  datasetReportFileName,
  formatDatasetReport,
  type DatasetReport,
} from './report.js';
