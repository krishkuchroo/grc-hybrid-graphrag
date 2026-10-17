// The benchmark (D1, D46): proves hybrid search against vector-only search on question sets with
// known answers, scores the answers by fixed rules, and runs the sets through the real API; and, for
// full-pipeline orgs, measures extraction against the answer key (D42).
export * from './questions/index.js';
export * from './score/index.js';
export * from './run/index.js';
export * from './extraction/index.js';
