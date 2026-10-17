// The benchmark's extraction part (S8-006; D24, D38, D42, D52.6): for an org whose data went through
// the full pipeline, how well extraction did against the answer key, read through the API and
// stored as one run. The API key and the databases are the command's
// (packages/infra/scripts/bench-run.ts).
export {
  ANSWER_KEY_FILE,
  AnswerKeyFileError,
  MAX_ANSWER_KEY_BYTES,
  answerKeyPathFor,
  answerKeyProblems,
  checkExtractionSet,
  fullPipelineSlugOf,
  loadAnswerKeyBeside,
  type AnswerKeyFileErrorCode,
  type ExtractionSetCheck,
} from './answer-key-file.js';
export {
  expectedOrg,
  identityOfFact,
  keyEnd,
  linkIdentity,
  sourceAliasOf,
  type AnswerKeyRecord,
  type ExpectedOrg,
  type PlantedLink,
} from './expected.js';
export { readOrgSnapshot, type ExtractionApi, type LinkFinding, type OrgLink, type OrgSnapshot } from './snapshot.js';
export { scoreExtraction, type ExtractionCounts, type ExtractionScore } from './score.js';
export { runExtraction, type ExtractionRunInput, type ExtractionRunResult } from './run.js';
export { extractionRunOutput, type ExtractionOutputContext } from './output.js';
export {
  EXTRACTION_REPORT_VERSION,
  extractionReport,
  formatExtractionReport,
  type ExtractionReport,
} from './report.js';
