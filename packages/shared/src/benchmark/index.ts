// The shared benchmark model (S8-001): the question kinds, parts and modes, the question-set file,
// every metric with its definition, the D48 targets, the injection checks, the result item, the run
// summary (`summariseBenchmark`), the request bodies and answers, the statuses, audit names and error
// codes, and plain words for the screen and the command. Used by the API, the web app and the
// benchmark command. Pure: no I/O, no clock, no randomness, and nothing from the API.
export * from './kinds.js';
export * from './question-set.js';
export * from './metrics.js';
export * from './injection-checks.js';
export * from './results.js';
export * from './summary.js';
export * from './bodies.js';
export * from './answers.js';
export * from './names.js';
export * from './words.js';
