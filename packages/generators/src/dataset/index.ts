// A dataset folder in the answer-key format (FT-001; D234, D235, D238 (b)): its files as one org's
// sources and mappings, and the full-pipeline base step's records and framework mappings through the
// API. `pnpm dataset:load` (packages/infra/scripts/dataset-load.ts) reads the folder and runs them.
export {
  DATASET_DOCUMENT_KINDS,
  DATASET_DOCUMENT_SOURCE,
  DatasetSourcesError,
  datasetSources,
  formatOfFileName,
  isByteFormat,
  type DatasetAssetList,
  type DatasetDocument,
  type DatasetDocumentKind,
  type DatasetSources,
  type DatasetSourcesInput,
} from './sources.js';
export {
  DATASET_PAGE_SIZE,
  DatasetApiClient,
  type DatasetApi,
  type DatasetApiClientOptions,
  type DatasetFramework,
  type DatasetRecordRow,
  type DatasetRequirement,
} from './client.js';
export {
  DATASET_RECORD_KINDS,
  DatasetLoadError,
  datasetRecordCounts,
  loadDatasetMappings,
  loadDatasetRecords,
  type DatasetFrameworkMapping,
  type DatasetMappingsResult,
  type DatasetRecordKind,
  type DatasetRecordsResult,
  type LoadDatasetRecordsOptions,
} from './load-records.js';
