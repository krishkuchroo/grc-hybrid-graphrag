// `pnpm --filter api setup:tokenizer` (S4-004; D25, D71, D81; planner's reading S4-Q1): puts bge-m3's
// own tokenizer files into `packages/api/tokenizer/` once, from the pinned revision of BAAI/bge-m3
// on Hugging Face (./tokenizer-source.ts). Run it on the Mac, in the checkout the Docker image is
// built from, before building: the image copies the folder with the package, and the worker never
// downloads anything.
// - A file already there with its pinned SHA-256 is kept as it is: nothing is downloaded again.
// - A file there that differs is refused: a fresh copy is downloaded and, once checked, replaces it.
// - A download whose size or SHA-256 isn't the pinned one is refused: nothing is written, and the
//   command ends with an error. A checked download is written beside the file and renamed over it,
//   so the folder never holds half a file.
// The output names only files, sizes, the revision and hashes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BGE_M3_TOKENIZER,
  TOKENIZER_SETUP_COMMAND,
  defaultTokenizerDir,
  tokenizerFileUrl,
  type TokenizerFile,
} from './tokenizer-source.js';

/** Why a download was refused. */
export type TokenizerDownloadProblem = 'download_failed' | 'size_mismatch' | 'hash_mismatch';

export class TokenizerDownloadError extends Error {
  constructor(
    readonly code: TokenizerDownloadProblem,
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'TokenizerDownloadError';
  }
}

/** What happened to each file: already there, downloaded, or downloaded over a file that differed. */
export type TokenizerFileOutcome = 'present' | 'downloaded' | 'replaced';

export interface SetupTokenizerOptions {
  /** The folder; `packages/api/tokenizer/` by default. */
  dir?: string;
  /** The fetch to download with; the global one by default. */
  fetch?: typeof fetch;
  /** Where progress lines go; nowhere by default. */
  log?: (line: string) => void;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readIfThere(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

// The body, read up to one byte past the pinned size, so a wrong file can't fill the disk.
async function download(fetchFn: typeof fetch, file: TokenizerFile): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetchFn(tokenizerFileUrl(file.name), { redirect: 'follow' });
  } catch {
    throw new TokenizerDownloadError('download_failed', file.name, 'the download could not start');
  }
  if (!res.ok || res.body === null) {
    throw new TokenizerDownloadError('download_failed', file.name, `the download answered ${res.status}`);
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size) {
        throw new TokenizerDownloadError('size_mismatch', file.name, `the download is over ${file.size} bytes`);
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof TokenizerDownloadError) throw err;
    throw new TokenizerDownloadError('download_failed', file.name, 'the download broke off');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size !== file.size) {
    throw new TokenizerDownloadError('size_mismatch', file.name, `the download is ${size} bytes, not ${file.size}`);
  }
  const bytes = Buffer.concat(parts);
  const got = sha256Hex(bytes);
  if (got !== file.sha256) {
    throw new TokenizerDownloadError(
      'hash_mismatch',
      file.name,
      `the download's SHA-256 is ${got}, not the pinned ${file.sha256}; nothing was written`,
    );
  }
  return bytes;
}

/** Sets the tokenizer files up in the folder (see the top of the file). */
export async function setupTokenizer(
  opts: SetupTokenizerOptions = {},
): Promise<Array<{ file: string; outcome: TokenizerFileOutcome }>> {
  const dir = opts.dir ?? defaultTokenizerDir();
  const fetchFn = opts.fetch ?? fetch;
  const log = opts.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });

  const done: Array<{ file: string; outcome: TokenizerFileOutcome }> = [];
  for (const file of BGE_M3_TOKENIZER.files) {
    const path = join(dir, file.name);
    const there = await readIfThere(path);
    if (there !== null && sha256Hex(there) === file.sha256) {
      log(`${file.name}: already there, SHA-256 matches`);
      done.push({ file: file.name, outcome: 'present' });
      continue;
    }
    if (there !== null) log(`${file.name}: the file there is not the pinned file; downloading a fresh copy`);
    else log(`${file.name}: downloading ${file.size} bytes`);

    const bytes = await download(fetchFn, file);
    const partial = join(dir, `.${file.name}.download`);
    try {
      await writeFile(partial, bytes);
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw err;
    }
    log(`${file.name}: saved, SHA-256 ${file.sha256}`);
    done.push({ file: file.name, outcome: there === null ? 'downloaded' : 'replaced' });
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = defaultTokenizerDir();
  console.log(
    `setup:tokenizer: bge-m3's tokenizer from ${BGE_M3_TOKENIZER.repository} at revision ${BGE_M3_TOKENIZER.revision}, into ${dir}`,
  );
  setupTokenizer({ dir, log: (line) => console.log(`  ${line}`) })
    .then(() => console.log('setup:tokenizer: done. The worker loads the tokenizer from this folder.'))
    .catch((err: unknown) => {
      if (err instanceof TokenizerDownloadError) console.error(`setup:tokenizer: refused: ${err.message}`);
      else {
        const e = err as { name?: unknown; code?: unknown } | null;
        console.error(`setup:tokenizer: failed (${String(e?.name ?? 'error')}${e?.code ? ` ${String(e.code)}` : ''})`);
      }
      console.error(`setup:tokenizer: fix the cause and run \`${TOKENIZER_SETUP_COMMAND}\` again.`);
      process.exitCode = 1;
    });
}
