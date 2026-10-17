// Question sets (S8-003): built from the generator's answer key (`buildQuestionSet`), and read and
// checked from a file, generated or hand-written (`loadQuestionSet`).
export { AnswerKeyError, answerKeySchema, parseAnswerKey, type AnswerKeyProblem } from './answer-key.js';
export {
  DEFAULT_PER_KIND,
  GENERATED_QUESTION_KINDS,
  MAX_EXPECTED_RECORDS,
  MAX_PER_KIND,
  QuestionSetBuildError,
  buildQuestionSet,
  buildQuestionSets,
  countByKind,
  formatQuestionSet,
  type BuildQuestionSetOptions,
  type GeneratedQuestionKind,
  type QuestionSetBuildErrorCode,
} from './build-question-set.js';
export {
  MAX_QUESTION_SET_BYTES,
  QuestionSetFileError,
  checkQuestionSet,
  loadQuestionSet,
  type QuestionSetFileErrorCode,
  type QuestionSetProblem,
} from './load-question-set.js';
export { isMadeUp } from './made-up-names.js';
export { OrgGraph, type GraphRecord, type LinkStep } from './org-graph.js';
export { MULTI_HOP_SHAPES, QUESTION_SHAPES, SINGLE_HOP_SHAPES, type QuestionShape } from './shapes.js';
export { fastLoadOrgSlug, fullPipelineOrgSlug, sizeFolderDescribes, sizeFolderName, sizeFolderOf } from './sizes.js';
