// The benchmark (D1, D46): proves hybrid search against vector-only search on question sets with
// known answers, scores the answers by fixed rules, and runs the sets through the real API; and, for
// full-pipeline orgs, measures extraction against the answer key (D42).
export * from './questions/index.js';
export * from './score/index.js';
export * from './run/index.js';
export * from './extraction/index.js';
export * from './dataset/index.js';
// The generated evaluation set and its checks file (EV-001; D261 track A): `pnpm eval:questions`.
export * from './eval/index.js';
// The made-up names of `no_answer` questions, for the training data's `graph_query` rows (TR-002).
export { assetPrefixOf, madeUpName } from './questions/made-up-names.js';
