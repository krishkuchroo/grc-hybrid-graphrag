// The changed-data test's record of what changed (EV-003; D261 track A, item 4): `changes.json` in a
// folder `pnpm eval:changed` wrote. It lists the records renamed (old name → made-up name) and the
// links deleted (with the sentences taken out of the documents). `pnpm eval:questions` reads it to
// fill each question's `forbidden` list and the checks file's `changed` block. Strict: unknown
// fields are refused everywhere. Errors name the field and the rule only, never a value (D163, D164).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { answerKeyKeySchema, benchmarkOrgSlugSchema, benchmarkRecordNameSchema } from '@grc/shared';
import { z } from 'zod';
import { fieldOf } from '../questions/answer-key.js';

export const CHANGES_FORMAT_VERSION = 1;

/** The file's name in a changed folder. */
export const CHANGES_FILE = 'changes.json';

/** A changes file this big is refused unread. */
export const MAX_CHANGES_FILE_BYTES = 8 * 1024 * 1024;

/** The kinds renamed, taken round-robin in this order. Assets are never renamed. */
export const RENAMED_KINDS = ['risk', 'control', 'policy', 'incident'] as const;
export type RenamedKind = (typeof RENAMED_KINDS)[number];

/** The link types deleted, taken round-robin in this order. */
export const DELETED_LINK_TYPES = ['MITIGATED_BY', 'GOVERNED_BY', 'IMPACTS', 'EXPOSES'] as const;
export type DeletedLinkType = (typeof DELETED_LINK_TYPES)[number];

/** The most renames and deletions one command may ask for. */
export const MAX_RENAMES = 40;
export const MAX_DELETIONS = 100;

/** The most stated sentences one deleted link may carry. */
const MAX_SENTENCES_PER_LINK = 50;

export const changeRenameSchema = z.strictObject({
  key: answerKeyKeySchema,
  kind: z.enum(RENAMED_KINDS),
  /** The old name, as the `--from` folder has it. */
  from: benchmarkRecordNameSchema,
  /** The made-up name it has now. */
  to: benchmarkRecordNameSchema,
  /** For a control: its 800-53 code (`AC-4`), after which the old name may still stand. */
  code: z.string().trim().min(1).max(100).optional(),
});

export const changeSentenceSchema = z.strictObject({
  file: z.string().min(1).max(255),
  sentence: z.string().min(1).max(10_000),
});

export const changeDeletionSchema = z.strictObject({
  type: z.enum(DELETED_LINK_TYPES),
  fromKey: answerKeyKeySchema,
  toKey: answerKeyKeySchema,
  /** The ends' names. */
  from: benchmarkRecordNameSchema,
  to: benchmarkRecordNameSchema,
  /** The sentences that stated the link, each taken out of its file. */
  sentences: z.array(changeSentenceSchema).max(MAX_SENTENCES_PER_LINK),
});

export const changesFileSchema = z
  .strictObject({
    version: z.literal(CHANGES_FORMAT_VERSION),
    from: z.strictObject({
      slug: benchmarkOrgSlugSchema,
      answerKeyVersion: z.string().trim().min(1).max(64),
    }),
    seed: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    renames: z.array(changeRenameSchema).max(MAX_RENAMES),
    deletions: z.array(changeDeletionSchema).max(MAX_DELETIONS),
  })
  .superRefine((changes, ctx) => {
    const keys = new Set<string>();
    changes.renames.forEach((r, i) => {
      if (keys.has(r.key)) ctx.addIssue({ code: 'custom', path: ['renames', i, 'key'], message: 'renamed twice' });
      keys.add(r.key);
      if (r.code !== undefined && r.kind !== 'control') {
        ctx.addIssue({ code: 'custom', path: ['renames', i, 'code'], message: 'only a control has a code' });
      }
    });
    const links = new Set<string>();
    changes.deletions.forEach((d, i) => {
      const id = `${d.type}|${d.fromKey}|${d.toKey}`;
      if (links.has(id)) ctx.addIssue({ code: 'custom', path: ['deletions', i], message: 'deleted twice' });
      links.add(id);
      if (keys.has(d.fromKey) || keys.has(d.toKey)) {
        ctx.addIssue({ code: 'custom', path: ['deletions', i], message: 'an end of a deleted link is never renamed' });
      }
    });
  });

export type ChangeRename = z.infer<typeof changeRenameSchema>;
export type ChangeDeletion = z.infer<typeof changeDeletionSchema>;
export type ChangeSentence = z.infer<typeof changeSentenceSchema>;
export type ChangesFile = z.infer<typeof changesFileSchema>;

/** One problem with a changes file: the field (`renames.3.to`) and what is wrong with it. */
export interface ChangesFileProblem {
  field: string;
  message: string;
}

/** A changes file that can't be used. The message names the field, never a value. */
export class ChangesFileError extends Error {
  constructor(readonly problems: readonly ChangesFileProblem[]) {
    const first = problems[0];
    super(first ? `${CHANGES_FILE} is not valid: ${first.field}: ${first.message}` : `${CHANGES_FILE} is not valid`);
    this.name = 'ChangesFileError';
  }
}

/** Checks a parsed changes file; a `ChangesFileError` names each field that's wrong. */
export function parseChangesFile(value: unknown): ChangesFile {
  const result = changesFileSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ChangesFileError(
    result.error.issues.map((issue) => ({ field: fieldOf(issue.path), message: issue.message })),
  );
}

/** The changes file as written: JSON with two-space indents and a final newline. */
export function formatChangesFile(changes: ChangesFile): string {
  return `${JSON.stringify(changes, null, 2)}\n`;
}

/** The folder's `changes.json`, checked; null when the folder has none. */
export async function loadChangesFile(dir: string): Promise<ChangesFile | null> {
  const path = join(dir, CHANGES_FILE);
  const whole = '(the whole file)';
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ChangesFileError([{ field: whole, message: 'is not a file' }]);
    if (info.size > MAX_CHANGES_FILE_BYTES) {
      throw new ChangesFileError([{ field: whole, message: `is over ${MAX_CHANGES_FILE_BYTES} bytes` }]);
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof ChangesFileError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return null;
    const shown = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
    throw new ChangesFileError([{ field: whole, message: `can't be read (${shown})` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // Never JSON's own message: it quotes the text around the mistake.
    throw new ChangesFileError([{ field: whole, message: 'is not valid JSON' }]);
  }
  return parseChangesFile(value);
}
