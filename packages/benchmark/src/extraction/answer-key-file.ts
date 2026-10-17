// What the extraction part runs against (S8-006; D18, D42, D45.8, D163, D164): only a generated
// question set, only on that set's full-pipeline org (`gen-<seed>-<n>`), and only with the answer key
// the set was built from, `answer-key.json` in the folder beside the set as `pnpm gen:data` wrote it.
// - A hand-written set, a set that names no full-pipeline org, or any other org (a fast-loaded one,
//   `fast-…`, went through no extraction) is refused.
// - The answer key is checked with S8-003's strict format, and refused when it comes from another
//   generator version than the set, or than these generators (its documents and plants would differ
//   from the ones uploaded), or has another seed, size or org than the set names.
// The problems name the rule, the field, slugs, keys and codes only, never a value from the data
// (D163, D164): not even JSON's own syntax message, which quotes the text around the mistake.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GENERATOR_VERSION, type AnswerKey } from '@grc/generators';
import type { GeneratedQuestionSetSource, QuestionSetSource } from '@grc/shared';
import { AnswerKeyError, parseAnswerKey, type AnswerKeyProblem } from '../questions/answer-key.js';
import { fullPipelineOrgSlug, sizeFolderDescribes } from '../questions/sizes.js';

/** The answer key's file name, beside the question sets `pnpm bench:questions` writes. */
export const ANSWER_KEY_FILE = 'answer-key.json';
/** `pnpm gen:data`'s answer keys are well under this; a bigger file is refused unread. */
export const MAX_ANSWER_KEY_BYTES = 512 * 1024 * 1024;

export type AnswerKeyFileErrorCode = 'missing' | 'unreadable' | 'too_large' | 'not_json' | 'invalid';

/** The answer key beside the set couldn't be used; for `invalid`, `problems` names each field. */
export class AnswerKeyFileError extends Error {
  constructor(
    readonly code: AnswerKeyFileErrorCode,
    message: string,
    readonly problems: readonly AnswerKeyProblem[] = [],
  ) {
    super(message);
    this.name = 'AnswerKeyFileError';
  }
}

/** The answer key's path for a question set's path: the same folder. */
export function answerKeyPathFor(setPath: string): string {
  return join(dirname(setPath), ANSWER_KEY_FILE);
}

/** Reads and checks the answer key in the question set's folder. */
export async function loadAnswerKeyBeside(setPath: string): Promise<AnswerKey> {
  const path = answerKeyPathFor(setPath);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new AnswerKeyFileError('missing', `the question set's folder has no ${ANSWER_KEY_FILE}`);
    if (info.size > MAX_ANSWER_KEY_BYTES) {
      throw new AnswerKeyFileError('too_large', `${ANSWER_KEY_FILE} is over ${MAX_ANSWER_KEY_BYTES} bytes`);
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof AnswerKeyFileError) throw err;
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
    if (code === 'ENOENT') {
      throw new AnswerKeyFileError(
        'missing',
        `the question set's folder has no ${ANSWER_KEY_FILE} (the extraction part reads the answer key pnpm gen:data wrote beside it)`,
      );
    }
    throw new AnswerKeyFileError('unreadable', `${ANSWER_KEY_FILE} could not be read (${code})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    throw new AnswerKeyFileError('not_json', `${ANSWER_KEY_FILE} is not valid JSON`);
  }
  try {
    return parseAnswerKey(value);
  } catch (err) {
    if (err instanceof AnswerKeyError) {
      const first = err.problems[0];
      throw new AnswerKeyFileError(
        'invalid',
        first ? `${ANSWER_KEY_FILE} is not valid: ${first.field}: ${first.message}` : `${ANSWER_KEY_FILE} is not valid`,
        err.problems,
      );
    }
    throw err;
  }
}

/** The full-pipeline org slug a generated set names (`gen-<seed>-<n>`), or null. */
export function fullPipelineSlugOf(source: GeneratedQuestionSetSource): string | null {
  const prefix = `gen-${source.seed}-`;
  return (
    source.orgSlugs.find((slug) => slug.startsWith(prefix) && /^[1-9]\d*$/.test(slug.slice(prefix.length))) ?? null
  );
}

export type ExtractionSetCheck = { ok: true; source: GeneratedQuestionSetSource } | { ok: false; problem: string };

/** Whether the extraction part may run with this set on this org: a generated set, on its own
 * full-pipeline org. */
export function checkExtractionSet(source: QuestionSetSource, org: string): ExtractionSetCheck {
  if (source.type !== 'generated') {
    return {
      ok: false,
      problem:
        'the extraction part needs a generated question set (pnpm bench:questions): a hand-written set has no answer key',
    };
  }
  const slug = fullPipelineSlugOf(source);
  if (slug === null) {
    return { ok: false, problem: 'the question set names no full-pipeline org (gen-<seed>-<n>) to measure' };
  }
  if (org !== slug) {
    return {
      ok: false,
      problem:
        `the extraction part is only for the set's full-pipeline org ${slug}, not ${org}: ` +
        'a fast-loaded org (fast-…) went through no extraction',
    };
  }
  return { ok: true, source };
}

/** What makes the answer key the wrong one for the set and org; empty when it is the right one. */
export function answerKeyProblems(key: AnswerKey, source: GeneratedQuestionSetSource, org: string): string[] {
  const problems: string[] = [];
  if (key.generatorVersion !== source.generatorVersion) {
    problems.push(`${ANSWER_KEY_FILE} comes from another generator version than the question set`);
  } else if (key.generatorVersion !== GENERATOR_VERSION) {
    problems.push(
      `${ANSWER_KEY_FILE} comes from another generator version than these generators (${GENERATOR_VERSION}), ` +
        'so its documents and plants would differ from the ones uploaded',
    );
  }
  if (key.seed !== source.seed) problems.push(`${ANSWER_KEY_FILE} has another seed than the question set`);
  if (!sizeFolderDescribes(source.size, key.size)) {
    problems.push(`${ANSWER_KEY_FILE} has another size than the question set`);
  }
  const index = key.orgs.findIndex((o) => o.key === source.orgKey);
  if (index < 0) {
    problems.push(`${ANSWER_KEY_FILE} has no org ${source.orgKey}`);
  } else if (key.seed === source.seed && fullPipelineOrgSlug(key.seed, index) !== org) {
    problems.push(`the answer key's org ${source.orgKey} is ${fullPipelineOrgSlug(key.seed, index)}, not ${org}`);
  }
  return problems;
}
