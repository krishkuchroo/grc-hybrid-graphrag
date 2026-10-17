// The benchmark command's run (S8-005): its arguments, its client for the API, finding the expected
// records, waiting for the org's documents, the run itself, its output and its report. The API key
// and the databases are the command's own (packages/infra/scripts/bench-run.ts).
export {
  BENCH_RUN_PARTS,
  BENCH_RUN_USAGE,
  DEFAULT_BENCH_BASE_URL,
  DEFAULT_BENCH_PART,
  DEFAULT_WAIT_MINUTES,
  MAX_WAIT_MINUTES,
  checkBenchBaseUrl,
  cleanBenchBaseUrl,
  parseBenchRunArgs,
  type BenchRunArgs,
  type BenchRunArgsResult,
  type BenchRunPartOption,
} from './args.js';
export {
  BenchApiClient,
  BenchStoppedError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_MS,
  LIST_PAGE_SIZE,
  abortableSleep,
  type AskOutcome,
  type BenchApi,
  type BenchApiClientOptions,
  type CallOptions,
  type ListedRecord,
} from './api-client.js';
export { itemCode, itemReference, sendableItem, unscoredItem } from './items.js';
export {
  answerKeySourceId,
  candidatesFor,
  expectedKinds,
  readOrgRecords,
  resolveQuestion,
  type OrgRecords,
  type QuestionResolution,
} from './resolve.js';
export {
  PROCESSED_DOCUMENT_KINDS,
  UNPROCESSED_STATUSES,
  unprocessedDocuments,
  waitForDocuments,
  type DocumentCounts,
  type WaitOptions,
  type WaitOutcome,
} from './wait.js';
export {
  BENCH_RUN_FAILURES,
  FINAL_CALL_TIMEOUT_MS,
  MAX_FAILURES_IN_A_ROW,
  benchErrorLine,
  isUnreachable,
  runBenchmark,
  type BenchRunInput,
  type BenchRunQuestion,
  type BenchRunResult,
  type BenchRunStored,
} from './run.js';
export { benchRunOutput, type BenchOutputContext } from './output.js';
export { BENCH_REPORT_VERSION, benchReport, formatBenchReport, type BenchReport } from './report.js';
