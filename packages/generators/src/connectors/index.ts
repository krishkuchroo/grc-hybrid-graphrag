// The dummy connectors (D11, D18, D42): the full-pipeline mode's client and run.
export {
  API_PREFIX,
  ApiClient,
  ApiRequestError,
  retryAfterMs,
  type ApiClientOptions,
  type ConnectorClient,
  type FetchLike,
  type PushBatchInput,
  type PushBatchResult,
  type SavedMapping,
  type UploadInput,
  type UploadResult,
} from './api-client.js';
export {
  AssetListError,
  assetRows,
  csvRows,
  jsonRows,
  parseCsvRecords,
  type AssetListFormat,
  type AssetRow,
  type FlatValue,
} from './asset-rows.js';
export {
  MAX_BATCH_BYTES,
  MAX_BATCH_ROWS,
  assetSourcesOf,
  batchIdOf,
  mappingOf,
  planPushBatches,
  runFullPipeline,
  type FullPipelineResult,
  type FullPipelineTarget,
  type OrgPipelineResult,
  type PlannedBatch,
  type RunFullPipelineInput,
} from './run-full.js';
