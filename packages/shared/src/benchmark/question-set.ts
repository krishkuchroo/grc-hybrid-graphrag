// The question-set file (S8-001; S8 shared notes, "Question kinds and scores"): a set of questions
// with known right answers, generated from the answer key (S8-003) or written by hand (S8-011), and
// read by the benchmark command (S8-005). Strict: unknown fields are refused everywhere.
// - `version`: the format version, `QUESTION_SET_FORMAT_VERSION`.
// - `source`: `generated` (the generator version, seed and size it was built from, the answer key's
//   org key, and the org slugs it fits) or `hand_written` (the org slugs it fits).
// - `questions`: 1 to 200, each with a stable ID (unique in the set), its kind, its text (the
//   search question rule: trimmed, then 1 to 2,000 characters) and its expected records (a record
//   kind plus a name, and the answer key's key when it has one):
//   - `single_hop`, `multi_hop`, `framework` and `injection_trap` expect 1 to 50 records;
//   - `no_answer` holds the made-up name and expects none;
//   - `injection_trap` also holds its injection: the kind, its document's file name and, for
//     `add_links`, the link it asks for (type and both ends' names).
import { z } from 'zod';
import { MAX_FILE_NAME_LENGTH } from '../intake/uploads.js';
import { questionSchema } from '../search/bodies.js';
import { SEARCH_LINK_TYPES, SEARCH_RECORD_KINDS } from '../search/kinds.js';
import { BENCHMARK_LIMITS, benchmarkItemKeySchema, benchmarkOrgSlugSchema } from './kinds.js';

export const QUESTION_SET_FORMAT_VERSION = 1;

export const QUESTION_SET_SOURCE_TYPES = ['generated', 'hand_written'] as const;
export type QuestionSetSourceType = (typeof QUESTION_SET_SOURCE_TYPES)[number];

/** A record's name as a question names it: trimmed, not empty, with no U+0000 and no lone surrogate. */
export const benchmarkRecordNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !s.includes('\u0000') && s.isWellFormed(), 'must not contain a null character or a lone surrogate');

/** An answer key's key, for a record (`AST-0001`) or an org (`ORG-01`). */
export const answerKeyKeySchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

/** A document's file name, as uploaded. */
export const benchmarkFileNameSchema = z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH);

const orgSlugs = z
  .array(benchmarkOrgSlugSchema)
  .min(1)
  .max(20)
  .refine((slugs) => new Set(slugs).size === slugs.length, 'each org slug only once');

export const generatedQuestionSetSourceSchema = z.strictObject({
  type: z.literal('generated'),
  /** `GENERATOR_VERSION` of `@grc/generators` when the answer key was made. */
  generatorVersion: z.string().trim().min(1).max(32),
  seed: z.int().min(0),
  /** The size as `gen:data` names its folder: `tiny`, `accuracy`, `stress` or a custom size's name. */
  size: z
    .string()
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** The answer key's org key, for example `ORG-01`. */
  orgKey: answerKeyKeySchema,
  /** The orgs it fits: `gen-<seed>-<n>` and `fast-<seed>-<size>-<n>`. */
  orgSlugs,
});

export const handWrittenQuestionSetSourceSchema = z.strictObject({
  type: z.literal('hand_written'),
  orgSlugs,
});

export const questionSetSourceSchema = z.discriminatedUnion('type', [
  generatedQuestionSetSourceSchema,
  handWrittenQuestionSetSourceSchema,
]);

/** A record a question expects in the answer: its kind and name, and the answer key's key if it has one. */
export const expectedRecordSchema = z.strictObject({
  kind: z.enum(SEARCH_RECORD_KINDS),
  name: benchmarkRecordNameSchema,
  key: answerKeyKeySchema.optional(),
});

const expected = z.array(expectedRecordSchema).min(1).max(BENCHMARK_LIMITS.expectedPerQuestion);

const questionBase = {
  /** Stable within the set, for example `single_hop-01`; its items' key. */
  id: benchmarkItemKeySchema,
  text: questionSchema,
};

export const singleHopQuestionSchema = z.strictObject({ ...questionBase, kind: z.literal('single_hop'), expected });
export const multiHopQuestionSchema = z.strictObject({ ...questionBase, kind: z.literal('multi_hop'), expected });
export const frameworkQuestionSchema = z.strictObject({ ...questionBase, kind: z.literal('framework'), expected });

export const noAnswerQuestionSchema = z.strictObject({
  ...questionBase,
  kind: z.literal('no_answer'),
  /** The made-up name the question asks about; no record has it. */
  madeUpName: benchmarkRecordNameSchema,
  /** Always empty: a no-answer question expects no records. */
  expected: z.array(expectedRecordSchema).max(0).default([]),
});

/** The link an add-links injection asks for: its type and both ends' names. */
export const injectionLinkSchema = z.strictObject({
  type: z.enum(SEARCH_LINK_TYPES),
  from: benchmarkRecordNameSchema,
  to: benchmarkRecordNameSchema,
});

export const questionInjectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ignore_instructions'), fileName: benchmarkFileNameSchema }),
  z.strictObject({ kind: z.literal('leak_data'), fileName: benchmarkFileNameSchema }),
  z.strictObject({ kind: z.literal('add_links'), fileName: benchmarkFileNameSchema, link: injectionLinkSchema }),
]);

export const injectionTrapQuestionSchema = z.strictObject({
  ...questionBase,
  kind: z.literal('injection_trap'),
  expected,
  injection: questionInjectionSchema,
});

export const benchmarkQuestionSchema = z.discriminatedUnion('kind', [
  singleHopQuestionSchema,
  multiHopQuestionSchema,
  frameworkQuestionSchema,
  noAnswerQuestionSchema,
  injectionTrapQuestionSchema,
]);

export const questionSetSchema = z
  .strictObject({
    version: z.literal(QUESTION_SET_FORMAT_VERSION),
    source: questionSetSourceSchema,
    questions: z.array(benchmarkQuestionSchema).min(1).max(BENCHMARK_LIMITS.questionsPerSet),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    set.questions.forEach((question, i) => {
      if (seen.has(question.id)) {
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'id'], message: 'question ID used twice' });
      }
      seen.add(question.id);
    });
  });

export type QuestionSetSource = z.infer<typeof questionSetSourceSchema>;
export type GeneratedQuestionSetSource = z.infer<typeof generatedQuestionSetSourceSchema>;
export type HandWrittenQuestionSetSource = z.infer<typeof handWrittenQuestionSetSourceSchema>;
export type ExpectedRecord = z.infer<typeof expectedRecordSchema>;
export type InjectionLink = z.infer<typeof injectionLinkSchema>;
export type QuestionInjection = z.infer<typeof questionInjectionSchema>;
export type BenchmarkQuestion = z.infer<typeof benchmarkQuestionSchema>;
export type QuestionSet = z.infer<typeof questionSetSchema>;

/** Checks a parsed question-set file (a ZodError naming the field that's wrong). */
export function parseQuestionSet(value: unknown): QuestionSet {
  return questionSetSchema.parse(value);
}

/** Whether the set's source names the org slug. */
export function questionSetFitsOrg(source: QuestionSetSource, slug: string): boolean {
  return source.orgSlugs.includes(slug);
}
