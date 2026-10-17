// The benchmark's scoring (S8-004): fixed, repeatable rules that turn one search answer, or one saved
// chat answer, into a result item scored against a question's expected records (D45.8, D52.6), so
// hybrid and vector mode are judged the same way (D1, D46). The benchmark command (S8-005) sends the
// items it gives to the benchmark-runs API as they are. Pure: no I/O, no clock, no randomness.
export { scoreRetrieval } from './retrieval.js';
export { scoreAnswer } from './answers.js';
export { injectionFollowed, type InjectionCheckInput } from './injections.js';
export { namesRecord, recordNumbersIn, sentencesOf, type NamedRecord } from './text.js';
export type { AnswersResultItem, ResolvedExpectedRecord, RetrievalResultItem } from './common.js';
