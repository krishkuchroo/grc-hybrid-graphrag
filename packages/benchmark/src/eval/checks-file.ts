// The checks file beside a generated evaluation set (EV-001; D261 track A, items 1 and 2):
// `<set without .json>.checks.json`. `pnpm eval:questions` writes it, `pnpm bench:run` reads it
// (EV-002) and the changed-data test fills `changed` and `forbidden` (EV-003). Strict: unknown
// fields are refused everywhere.
// - `folder`: the dataset folder's manifest slug and its answer key's `generatorVersion`.
// - `seed`, and `count`: the questions written (the length of `questions`).
// - `changed`: null, or the changed-data test's `{ fromSlug, renames, deletions }` (EV-003; the
//   number of records renamed and links deleted).
// - `questions`: one per question of the set, in the set's order: its ID (`<group>.<wording>`), its
//   group (one fact), its fine kind, its wording, the kinds of the records it asks for, the
//   correct graph query (null when it has none) and the names an answer must not show.
// A checks file fits its set when its question IDs are exactly the set's, in the set's order.
// Errors name the field and the rule only, never a value from the file (D163, D164).
import { readFile, stat } from 'node:fs/promises';
import {
  SEARCH_LIMITS,
  SEARCH_RECORD_KINDS,
  benchmarkItemKeySchema,
  benchmarkOrgSlugSchema,
  benchmarkRecordNameSchema,
  type QuestionSet,
} from '@grc/shared';
import { z } from 'zod';
import { fieldOf } from '../questions/answer-key.js';
import { loadQuestionSet } from '../questions/load-question-set.js';
import { EVAL_MAX_COUNT, EVAL_QUESTION_KINDS, EVAL_SET_KIND, EVAL_WORDINGS, evalQuestionId } from './kinds.js';

export const EVAL_CHECKS_FORMAT_VERSION = 1;

/** A checks file of 200 questions fits easily; a bigger file is refused unread. */
export const MAX_CHECKS_FILE_BYTES = 8 * 1024 * 1024;

/** Why an answer must not show a name: an old name of a renamed record, or a deleted link's end. */
export const FORBIDDEN_REASONS = ['renamed', 'deleted_link'] as const;
export type ForbiddenReason = (typeof FORBIDDEN_REASONS)[number];

export const evalForbiddenSchema = z.strictObject({
  name: benchmarkRecordNameSchema,
  why: z.enum(FORBIDDEN_REASONS),
  /** For a renamed control: the name may follow this (its code), as in `AC-4 <old title>`. */
  exceptAfter: z.string().trim().min(1).max(200).optional(),
});

export const evalCheckQuestionSchema = z.strictObject({
  id: benchmarkItemKeySchema,
  group: benchmarkItemKeySchema,
  kind: z.enum(EVAL_QUESTION_KINDS),
  wording: z.enum(EVAL_WORDINGS),
  targetKinds: z.array(z.enum(SEARCH_RECORD_KINDS)).min(1).max(SEARCH_RECORD_KINDS.length),
  goldQuery: z.string().min(1).max(SEARCH_LIMITS.graphQueryMaxLength).nullable(),
  forbidden: z.array(evalForbiddenSchema).max(200),
});

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const evalChangedSchema = z.strictObject({
  fromSlug: benchmarkOrgSlugSchema,
  renames: count,
  deletions: count,
});

export const evalChecksSchema = z
  .strictObject({
    version: z.literal(EVAL_CHECKS_FORMAT_VERSION),
    folder: z.strictObject({
      slug: benchmarkOrgSlugSchema,
      answerKeyVersion: z.string().trim().min(1).max(64),
    }),
    seed: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    count: z.int().min(1).max(EVAL_MAX_COUNT),
    changed: evalChangedSchema.nullable(),
    questions: z.array(evalCheckQuestionSchema).min(1).max(EVAL_MAX_COUNT),
  })
  .superRefine((checks, ctx) => {
    if (checks.count !== checks.questions.length) {
      ctx.addIssue({ code: 'custom', path: ['count'], message: 'must be the number of questions' });
    }
    const seen = new Set<string>();
    checks.questions.forEach((q, i) => {
      if (seen.has(q.id))
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'id'], message: 'question ID used twice' });
      seen.add(q.id);
      if (q.id !== evalQuestionId(q.group, q.wording)) {
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'id'], message: 'must be <group>.<wording>' });
      }
      if ((q.kind === 'fixed') !== (q.wording === 'reported')) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'wording'],
          message: 'a fixed question is worded reported, and only a fixed one',
        });
      }
    });
  });

export type EvalForbidden = z.infer<typeof evalForbiddenSchema>;
export type EvalCheckQuestion = z.infer<typeof evalCheckQuestionSchema>;
export type EvalChecks = z.infer<typeof evalChecksSchema>;

/** One problem with a checks file: the field (`questions.3.goldQuery`) and what is wrong with it. */
export interface ChecksFileProblem {
  field: string;
  message: string;
}

/** A checks file that can't be used. The message names the field, never a value. */
export class ChecksFileError extends Error {
  constructor(readonly problems: readonly ChecksFileProblem[]) {
    const first = problems[0];
    super(first ? `the checks file is not valid: ${first.field}: ${first.message}` : 'the checks file is not valid');
    this.name = 'ChecksFileError';
  }

  /** The first field that's wrong. */
  get field(): string | undefined {
    return this.problems[0]?.field;
  }
}

/** The checks file's path for a set's path: `<set without .json>.checks.json`. */
export function checksPathFor(setPath: string): string {
  return `${setPath.endsWith('.json') ? setPath.slice(0, -'.json'.length) : setPath}.checks.json`;
}

/** Checks a parsed checks file; a `ChecksFileError` names each field that's wrong. */
export function parseEvalChecks(value: unknown): EvalChecks {
  const result = evalChecksSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ChecksFileError(
    result.error.issues.map((issue) => ({ field: fieldOf(issue.path), message: issue.message })),
  );
}

/**
 * Throws a `ChecksFileError` unless the checks file fits the set: the same question IDs in the same
 * order, and each generated question's fine kind written as its set kind.
 */
export function checkChecksFitSet(checks: EvalChecks, set: QuestionSet): void {
  const problems: ChecksFileProblem[] = [];
  if (checks.questions.length !== set.questions.length) {
    problems.push({ field: 'questions', message: "must hold exactly the set's questions" });
  }
  const n = Math.min(checks.questions.length, set.questions.length);
  for (let i = 0; i < n; i++) {
    const check = checks.questions[i]!;
    const question = set.questions[i]!;
    if (check.id !== question.id) {
      problems.push({ field: `questions.${i}.id`, message: "must be the set's question ID at the same place" });
      continue;
    }
    if (check.kind !== 'fixed' && EVAL_SET_KIND[check.kind] !== question.kind) {
      problems.push({ field: `questions.${i}.kind`, message: "doesn't fit the set question's kind" });
    }
  }
  if (problems.length > 0) throw new ChecksFileError(problems);
}

/** The checks file as written: JSON with two-space indents and a final newline. */
export function formatEvalChecks(checks: EvalChecks): string {
  return `${JSON.stringify(checks, null, 2)}\n`;
}

/**
 * The checks file beside a set (`checksPathFor`), checked and fitted to the set; null when there is
 * no such file. The set is read from `setPath` unless it is given.
 */
export async function loadChecksBeside(setPath: string, set?: QuestionSet): Promise<EvalChecks | null> {
  const path = checksPathFor(setPath);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ChecksFileError([{ field: '(the whole file)', message: 'is not a file' }]);
    if (info.size > MAX_CHECKS_FILE_BYTES) {
      throw new ChecksFileError([{ field: '(the whole file)', message: `is over ${MAX_CHECKS_FILE_BYTES} bytes` }]);
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof ChecksFileError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return null;
    const shown = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
    throw new ChecksFileError([{ field: '(the whole file)', message: `can't be read (${shown})` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    // Never JSON's own message: it quotes the text around the mistake.
    throw new ChecksFileError([{ field: '(the whole file)', message: 'is not valid JSON' }]);
  }
  const checks = parseEvalChecks(value);
  checkChecksFitSet(checks, set ?? (await loadQuestionSet(setPath)));
  return checks;
}
