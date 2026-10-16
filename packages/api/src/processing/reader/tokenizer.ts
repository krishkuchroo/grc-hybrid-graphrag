// bge-m3's own tokenizer, for counting chunk tokens (S4-004; D25, D71): loaded from the local files
// `pnpm --filter api setup:tokenizer` put in `packages/api/tokenizer/` (./tokenizer-source.ts),
// through @huggingface/tokenizers, a tokenizer library that reads `tokenizer.json` with no network.
// Nothing here downloads: a missing file, or one whose SHA-256 isn't the pinned one, is a
// `TokenizerUnavailableError` naming the command to run.
//
// A count is the number of tokens bge-m3 makes of the text, without its `<s>` and `</s>`. Only the
// worker program loads it, once, on its first read job (about 170 MB of heap).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  BGE_M3_TOKENIZER,
  TOKENIZER_CONFIG_JSON,
  TOKENIZER_JSON,
  TOKENIZER_SETUP_COMMAND,
  defaultTokenizerDir,
} from './tokenizer-source.js';

/** Counts tokens: what the chunker needs from a tokenizer. */
export interface TokenCounter {
  count(text: string): number;
}

/** Why the tokenizer can't be used: a file is missing, or isn't the pinned file. */
export type TokenizerProblem = 'tokenizer_missing' | 'tokenizer_mismatch';

/** The tokenizer files aren't there, or aren't the pinned ones. The message names the command. */
export class TokenizerUnavailableError extends Error {
  readonly code: TokenizerProblem;
  /** The file that is missing or differs. */
  readonly file: string;

  constructor(code: TokenizerProblem, file: string) {
    super(
      code === 'tokenizer_missing'
        ? `bge-m3's tokenizer file ${file} is missing; run \`${TOKENIZER_SETUP_COMMAND}\` once.`
        : `bge-m3's tokenizer file ${file} is not the pinned file; run \`${TOKENIZER_SETUP_COMMAND}\` again.`,
    );
    this.name = 'TokenizerUnavailableError';
    this.code = code;
    this.file = file;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Reads one pinned file and checks its hash. */
async function readPinned(dir: string, name: string, sha256: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, name));
  } catch (err) {
    if (isMissing(err)) throw new TokenizerUnavailableError('tokenizer_missing', name);
    throw err;
  }
  if (sha256Hex(bytes) !== sha256) throw new TokenizerUnavailableError('tokenizer_mismatch', name);
  return bytes;
}

/**
 * Checks that every tokenizer file is in `dir` with its pinned hash, without loading it. Throws
 * a `TokenizerUnavailableError` for the first one that isn't.
 */
export async function checkTokenizerFiles(dir: string = defaultTokenizerDir()): Promise<void> {
  for (const file of BGE_M3_TOKENIZER.files) await readPinned(dir, file.name, file.sha256);
}

/** Loads the tokenizer from `dir`, after checking every file's hash. */
export async function loadTokenCounter(dir: string = defaultTokenizerDir()): Promise<TokenCounter> {
  const tokenizerJson: unknown = JSON.parse(
    (await readPinned(dir, TOKENIZER_JSON.name, TOKENIZER_JSON.sha256)).toString('utf8'),
  );
  const config: unknown = JSON.parse(
    (await readPinned(dir, TOKENIZER_CONFIG_JSON.name, TOKENIZER_CONFIG_JSON.sha256)).toString('utf8'),
  );
  const tokenizer = new Tokenizer(tokenizerJson as object, config as object);
  return {
    count: (text: string): number =>
      text === '' ? 0 : tokenizer.encode(text, { add_special_tokens: false }).ids.length,
  };
}

/**
 * The worker's one tokenizer: loaded on first use and kept. A load that fails isn't kept, so the
 * next job tries again (after the files have been set up).
 */
export class BgeM3Tokenizer {
  private loading: Promise<TokenCounter> | null = null;

  constructor(private readonly dir: string = defaultTokenizerDir()) {}

  get(): Promise<TokenCounter> {
    if (!this.loading) {
      const loading = loadTokenCounter(this.dir);
      loading.catch(() => {
        if (this.loading === loading) this.loading = null;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  /** Checks the files without loading them (the worker's start-up message). */
  check(): Promise<void> {
    return checkTokenizerFiles(this.dir);
  }
}
