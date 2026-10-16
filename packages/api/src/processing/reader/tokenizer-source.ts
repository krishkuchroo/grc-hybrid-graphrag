// Where bge-m3's own tokenizer comes from (S4-004; D25, D71, D81; planner's reading S4-Q1): the
// BAAI/bge-m3 repository on Hugging Face at one fixed revision, each file with the SHA-256 it must
// have. `pnpm --filter api setup:tokenizer` (./setup-tokenizer.ts) downloads the files once into the
// git-ignored folder `packages/api/tokenizer/` (not `models/`, which the Docker build skips, so the
// image gets the folder with the rest of the package) and refuses a file whose hash differs. The
// worker loads them from there (./tokenizer.ts), checks the same hashes, and never downloads.
// No imports of ours, so the setup command loads nothing else.
import { fileURLToPath } from 'node:url';

/** The command that sets the tokenizer up, as the worker names it when the files are missing. */
export const TOKENIZER_SETUP_COMMAND = 'pnpm --filter api setup:tokenizer';

export interface TokenizerFile {
  /** The file's name, the same in the repository and in the folder. */
  name: string;
  /** Its SHA-256, lowercase hex. */
  sha256: string;
  /** Its size in bytes. */
  size: number;
}

/** The tokenizer itself: XLM-RoBERTa's Unigram model with its normalizer and pre-tokenizer. */
export const TOKENIZER_JSON: Readonly<TokenizerFile> = Object.freeze({
  name: 'tokenizer.json',
  sha256: '21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08',
  size: 17_098_108,
});

/** Its settings (special tokens, clean-up), which the tokenizer library reads with it. */
export const TOKENIZER_CONFIG_JSON: Readonly<TokenizerFile> = Object.freeze({
  name: 'tokenizer_config.json',
  sha256: 'a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4',
  size: 444,
});

export const BGE_M3_TOKENIZER = Object.freeze({
  repository: 'BAAI/bge-m3',
  revision: '5617a9f61b028005a4858fdac845db406aefb181',
  files: Object.freeze([TOKENIZER_JSON, TOKENIZER_CONFIG_JSON]),
});

/** A file's download address: the pinned revision, never `main`. */
export function tokenizerFileUrl(name: string): string {
  return `https://huggingface.co/${BGE_M3_TOKENIZER.repository}/resolve/${BGE_M3_TOKENIZER.revision}/${name}`;
}

/** The folder the files live in: `packages/api/tokenizer/`, git-ignored (D81). */
export function defaultTokenizerDir(): string {
  return fileURLToPath(new URL('../../../tokenizer/', import.meta.url));
}
