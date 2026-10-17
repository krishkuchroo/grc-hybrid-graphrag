// Reads a question-set file, generated (`pnpm bench:questions`) or hand-written, and checks it with
// S8-001's format (`questionSetSchema`; S8-003). A bad file is refused with the field that's wrong.
// The error names the field and the rule only, never a question, a name or other text from the file
// (D163, D164): not even JSON's own syntax message, which quotes the text around the mistake.
import { readFile, stat } from 'node:fs/promises';
import { questionSetSchema, type QuestionSet } from '@grc/shared';
import { fieldOf } from './answer-key.js';

/** A question set of 200 questions of 2,000 characters fits easily; a bigger file is refused unread. */
export const MAX_QUESTION_SET_BYTES = 4 * 1024 * 1024;

export type QuestionSetFileErrorCode = 'unreadable' | 'too_large' | 'not_json' | 'invalid';

/** One problem with a question set: the field (`questions.3.text`) and what is wrong with it. */
export interface QuestionSetProblem {
  field: string;
  message: string;
}

export class QuestionSetFileError extends Error {
  constructor(
    readonly code: QuestionSetFileErrorCode,
    message: string,
    /** For `invalid`: every field that's wrong. */
    readonly problems: readonly QuestionSetProblem[] = [],
  ) {
    super(message);
    this.name = 'QuestionSetFileError';
  }

  /** The first field that's wrong, for `invalid`. */
  get field(): string | undefined {
    return this.problems[0]?.field;
  }
}

/** Checks a parsed question set; a `QuestionSetFileError` (`invalid`) names each field that's wrong. */
export function checkQuestionSet(value: unknown): QuestionSet {
  const result = questionSetSchema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => ({ field: fieldOf(issue.path), message: issue.message }));
  const first = problems[0];
  throw new QuestionSetFileError(
    'invalid',
    first ? `the question set is not valid: ${first.field}: ${first.message}` : 'the question set is not valid',
    problems,
  );
}

/** Reads and checks a question-set file. */
export async function loadQuestionSet(path: string): Promise<QuestionSet> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new QuestionSetFileError('unreadable', 'the question set path is not a file');
    if (info.size > MAX_QUESTION_SET_BYTES) {
      throw new QuestionSetFileError('too_large', `the question set file is over ${MAX_QUESTION_SET_BYTES} bytes`);
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof QuestionSetFileError) throw err;
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
    throw new QuestionSetFileError('unreadable', `the question set file could not be read (${code})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    throw new QuestionSetFileError('not_json', 'the question set file is not valid JSON');
  }
  return checkQuestionSet(value);
}
