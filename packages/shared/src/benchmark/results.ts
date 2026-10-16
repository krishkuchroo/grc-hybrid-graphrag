// A benchmark result item (S8-001; S8 shared notes, "Question kinds and scores"): one question in one
// part and mode, or one extraction item, with its outcome, its metric values and its details.
// - `itemKey`: the question's ID, or the extraction item's key. Unique per run and mode.
// - `part`, `mode` and `kind`: a question's items are `retrieval` or `answers` in `hybrid` or
//   `vector`, with the question's kind; extraction items are `extraction` in `pipeline`, with an
//   extraction item kind.
// - `outcome`: `pass`, `partial`, `fail` or `skipped`. A skipped item has a reason code in
//   `details.reason`; a failed one may have one (its error code); a passed or partial one has none.
// - `metrics`: the item's score and time values (./metrics.ts), each only for its part, and only in
//   the modes and question kinds the metric lists. A metric that wasn't measured is left out or null.
// - `details`, for a question: its text; the expected records (number, name, kind; the number is
//   null when the org has no such record); the expected records found and whether each was in the
//   context; the first matching rank; the graph part (ran, query, fallback reason); the timings; for
//   answers the answer (at most 4,000 characters), its status and its citations; for an injection
//   trap, its kind, file name and whether the planted instruction was followed; the error's
//   reference ID when it failed. For an extraction item: the link type, both ends (number and name,
//   or the answer key's name when the org has no such record), its state, and the plant it comes
//   from, if any.
// Two forms: the stored form (`benchmarkResultItemSchema`, answers at most 4,000 characters) and the
// form a batch may send (`benchmarkResultItemInputSchema`: any answer length; the API cuts it with
// `cutBenchmarkAnswer`). Texts may not hold U+0000 or a lone surrogate, so every item can be stored.
import { z } from 'zod';
import { CHAT_MESSAGE_STATUSES } from '../chat/messages.js';
import { searchRecordNumberSchema } from '../search/answers.js';
import { GRAPH_FALLBACK_REASONS } from '../search/fallback.js';
import { SEARCH_LINK_TYPES, SEARCH_RECORD_KINDS } from '../search/kinds.js';
import { SEARCH_LIMITS } from '../search/limits.js';
import { SEARCH_MODES } from '../search/modes.js';
import { sourceNumberSchema } from '../search/sources.js';
import {
  BENCHMARK_EXTRACTION_MODE,
  BENCHMARK_INJECTION_KINDS,
  BENCHMARK_LIMITS,
  BENCHMARK_OUTCOMES,
  BENCHMARK_QUESTION_KINDS,
  EXTRACTION_ITEM_KINDS,
  EXTRACTION_LINK_STATES,
  benchmarkCodeSchema,
  benchmarkItemKeySchema,
  cutBenchmarkAnswer,
  type BenchmarkItemKind,
  type BenchmarkMode,
  type BenchmarkOutcome,
  type BenchmarkPart,
} from './kinds.js';
import {
  BENCHMARK_ITEM_METRICS,
  BENCHMARK_METRIC_BY_NAME,
  metricAppliesTo,
  type BenchmarkItemMetric,
} from './metrics.js';
import { benchmarkFileNameSchema } from './question-set.js';

const ms = z.number().min(0);
const dateTime = z.iso.datetime({ offset: true });

/** Text that can be stored: no U+0000 and no lone surrogate. */
export const benchmarkTextSchema = z
  .string()
  .refine((s) => !s.includes('\u0000') && s.isWellFormed(), 'must not contain a null character or a lone surrogate');

const recordKind = z.enum(SEARCH_RECORD_KINDS);

type MetricValue = z.ZodOptional<z.ZodNullable<z.ZodNumber>>;

/** An item's metric values: a score from 0 to 1, or milliseconds from 0. Unknown names are refused. */
export const benchmarkItemMetricsSchema = z.strictObject(
  Object.fromEntries(
    BENCHMARK_ITEM_METRICS.map((name) => {
      const value = BENCHMARK_METRIC_BY_NAME[name].type === 'time' ? z.number().min(0) : z.number().min(0).max(1);
      return [name, value.nullable().optional()];
    }),
  ) as { [K in BenchmarkItemMetric]: MetricValue },
);

/** An expected record as the org holds it; `number` is null when the org has no such record. */
export const benchmarkExpectedDetailSchema = z.strictObject({
  number: searchRecordNumberSchema.nullable(),
  name: benchmarkTextSchema,
  kind: recordKind,
});

/** An expected record the results held: its best rank there, and whether it was in the context. */
export const benchmarkFoundRecordSchema = z.strictObject({
  number: searchRecordNumberSchema,
  name: benchmarkTextSchema,
  kind: recordKind,
  /** The best (lowest) rank of a result that is or names it. */
  rank: z.int().min(1),
  inContext: z.boolean(),
});

/** The graph path (Path B) as the search or the answer reported it. Vector mode: never ran. */
export const benchmarkGraphDetailSchema = z.strictObject({
  ran: z.boolean(),
  /** The graph query Gemma wrote, if it wrote one. */
  query: benchmarkTextSchema.nullable(),
  fallback: z.enum(GRAPH_FALLBACK_REASONS).nullable(),
});

/** The timings, in milliseconds; null for a step that didn't run or isn't known. */
export const benchmarkTimingsSchema = z.strictObject({
  embeddingMs: ms.nullable(),
  vectorSearchMs: ms.nullable(),
  queryWritingMs: ms.nullable(),
  queryRunningMs: ms.nullable(),
  fusionMs: ms.nullable(),
  /** Waiting for Gemma's turn (answers). */
  waitedMs: ms.nullable(),
  firstWordsMs: ms.nullable(),
  totalMs: ms.nullable(),
});

/** A citation of the answer: a record or a passage with whether its source is or names an expected
 * record, or one the asker couldn't see. */
export const benchmarkCitationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    number: sourceNumberSchema,
    type: z.literal('record'),
    record: z.strictObject({ number: searchRecordNumberSchema, name: benchmarkTextSchema, kind: recordKind }),
    matches: z.boolean(),
  }),
  z.strictObject({
    number: sourceNumberSchema,
    type: z.literal('passage'),
    documentId: z.uuid(),
    documentName: benchmarkTextSchema,
    position: z.int().min(0),
    matches: z.boolean(),
  }),
  z.strictObject({ number: sourceNumberSchema, type: z.literal('hidden') }),
]);

function answerDetailSchema<T extends z.ZodType<string>>(text: T) {
  return z.strictObject({
    text,
    status: z.enum(CHAT_MESSAGE_STATUSES),
    citations: z.array(benchmarkCitationSchema).max(BENCHMARK_LIMITS.citationsPerAnswer),
  });
}

/** The stored answer: at most 4,000 characters. */
export const benchmarkAnswerDetailSchema = answerDetailSchema(
  benchmarkTextSchema.max(BENCHMARK_LIMITS.answerMaxLength),
);
/** The answer as a batch may send it: any length, cut by the API. */
export const benchmarkAnswerDetailInputSchema = answerDetailSchema(benchmarkTextSchema);

/** An injection trap's check: the planted instruction's kind and document, and whether the answer
 * followed it (null when no answer was checked, as in retrieval). */
export const benchmarkInjectionDetailSchema = z.strictObject({
  kind: z.enum(BENCHMARK_INJECTION_KINDS),
  fileName: benchmarkFileNameSchema,
  followed: z.boolean().nullable(),
});

const expectedList = z.array(benchmarkExpectedDetailSchema).max(BENCHMARK_LIMITS.expectedPerQuestion);

function questionDetailsSchema<A extends z.ZodType>(answer: A) {
  return z.strictObject({
    /** Why it was skipped, or the error code it failed with. */
    reason: benchmarkCodeSchema.nullable(),
    /** The reference ID of the API error it failed with (D47). */
    referenceId: z.string().min(1).max(100).nullable(),
    question: benchmarkTextSchema.max(SEARCH_LIMITS.questionMaxLength),
    expected: expectedList,
    found: z.array(benchmarkFoundRecordSchema).max(BENCHMARK_LIMITS.expectedPerQuestion),
    firstMatchRank: z.int().min(1).nullable(),
    /** Null when the search or question didn't get that far. */
    graph: benchmarkGraphDetailSchema.nullable(),
    timings: benchmarkTimingsSchema,
    answer,
    injection: benchmarkInjectionDetailSchema.nullable(),
  });
}

/** A retrieval item's details: no answer. */
export const benchmarkRetrievalDetailsSchema = questionDetailsSchema(z.null());
/** An answers item's details: the answer, or null when none could be read (failed or hidden). */
export const benchmarkAnswersDetailsSchema = questionDetailsSchema(benchmarkAnswerDetailSchema.nullable());
const benchmarkAnswersDetailsInputSchema = questionDetailsSchema(benchmarkAnswerDetailInputSchema.nullable());

/** A link end: the org's record number (null when the org has no such record) and its name. */
export const extractionLinkEndSchema = z.strictObject({
  number: searchRecordNumberSchema.nullable(),
  name: benchmarkTextSchema,
});

/** The plant an extraction item comes from: a planted false positive, or a planted injection. */
export const extractionPlantSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('false_positive'), fileName: benchmarkFileNameSchema }),
  z.strictObject({
    type: z.literal('injection'),
    fileName: benchmarkFileNameSchema,
    injectionKind: z.enum(BENCHMARK_INJECTION_KINDS),
  }),
]);

export const benchmarkExtractionDetailsSchema = z.strictObject({
  /** Why it was skipped, or the error code it failed with. */
  reason: benchmarkCodeSchema.nullable(),
  linkType: z.enum(SEARCH_LINK_TYPES),
  from: extractionLinkEndSchema,
  to: extractionLinkEndSchema,
  state: z.enum(EXTRACTION_LINK_STATES),
  plant: extractionPlantSchema.nullable(),
});

const itemBase = {
  itemKey: benchmarkItemKeySchema,
  outcome: z.enum(BENCHMARK_OUTCOMES),
  metrics: benchmarkItemMetricsSchema,
};

const questionItemBase = {
  ...itemBase,
  mode: z.enum(SEARCH_MODES),
  kind: z.enum(BENCHMARK_QUESTION_KINDS),
};

const retrievalItemShape = {
  ...questionItemBase,
  part: z.literal('retrieval'),
  details: benchmarkRetrievalDetailsSchema,
};
const answersItemShape = { ...questionItemBase, part: z.literal('answers'), details: benchmarkAnswersDetailsSchema };
const answersItemInputShape = {
  ...questionItemBase,
  part: z.literal('answers'),
  details: benchmarkAnswersDetailsInputSchema,
};
const extractionItemShape = {
  ...itemBase,
  part: z.literal('extraction'),
  mode: z.literal(BENCHMARK_EXTRACTION_MODE),
  kind: z.enum(EXTRACTION_ITEM_KINDS),
  details: benchmarkExtractionDetailsSchema,
};

/** What every item form has in common, for the cross-field checks. */
interface CheckedItem {
  part: BenchmarkPart;
  mode: BenchmarkMode;
  kind: BenchmarkItemKind;
  outcome: BenchmarkOutcome;
  metrics: Partial<Record<BenchmarkItemMetric, number | null>>;
  details: { reason: string | null };
}

/** The rules across fields: each metric only for its part, modes and kinds; a skipped item has a
 * reason; a passed or partial one has none. */
function checkItem(item: CheckedItem, ctx: z.core.$RefinementCtx): void {
  for (const [name, value] of Object.entries(item.metrics)) {
    if (value === undefined || value === null) continue;
    if (!metricAppliesTo(name as BenchmarkItemMetric, item.part, item.mode, item.kind)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', name], message: 'not measured for this part, mode or kind' });
    }
  }
  if (item.outcome === 'skipped' && item.details.reason === null) {
    ctx.addIssue({ code: 'custom', path: ['details', 'reason'], message: 'a skipped item needs its reason' });
  }
  if ((item.outcome === 'pass' || item.outcome === 'partial') && item.details.reason !== null) {
    ctx.addIssue({ code: 'custom', path: ['details', 'reason'], message: 'only a skipped or failed item has a reason' });
  }
}

/** A result item as stored and read back. */
export const benchmarkResultItemSchema = z
  .discriminatedUnion('part', [
    z.strictObject(retrievalItemShape),
    z.strictObject(answersItemShape),
    z.strictObject(extractionItemShape),
  ])
  .superRefine((item, ctx) => checkItem(item, ctx));

/** A result item as a batch may send it: an answer of any length, which the API cuts to 4,000
 * characters (`cutBenchmarkAnswer`). */
export const benchmarkResultItemInputSchema = z
  .discriminatedUnion('part', [
    z.strictObject(retrievalItemShape),
    z.strictObject(answersItemInputShape),
    z.strictObject(extractionItemShape),
  ])
  .superRefine((item, ctx) => checkItem(item, ctx));

/** A row of `GET /api/v1/benchmark/runs/:id/results`: the item and when it was stored. */
export const benchmarkResultRowSchema = z.discriminatedUnion('part', [
  z.object({ ...retrievalItemShape, createdAt: dateTime }),
  z.object({ ...answersItemShape, createdAt: dateTime }),
  z.object({ ...extractionItemShape, createdAt: dateTime }),
]);

export type BenchmarkItemMetrics = z.infer<typeof benchmarkItemMetricsSchema>;
export type BenchmarkExpectedDetail = z.infer<typeof benchmarkExpectedDetailSchema>;
export type BenchmarkFoundRecord = z.infer<typeof benchmarkFoundRecordSchema>;
export type BenchmarkGraphDetail = z.infer<typeof benchmarkGraphDetailSchema>;
export type BenchmarkTimings = z.infer<typeof benchmarkTimingsSchema>;
export type BenchmarkCitation = z.infer<typeof benchmarkCitationSchema>;
export type BenchmarkAnswerDetail = z.infer<typeof benchmarkAnswerDetailSchema>;
export type BenchmarkInjectionDetail = z.infer<typeof benchmarkInjectionDetailSchema>;
export type BenchmarkRetrievalDetails = z.infer<typeof benchmarkRetrievalDetailsSchema>;
export type BenchmarkAnswersDetails = z.infer<typeof benchmarkAnswersDetailsSchema>;
export type ExtractionLinkEnd = z.infer<typeof extractionLinkEndSchema>;
export type ExtractionPlant = z.infer<typeof extractionPlantSchema>;
export type BenchmarkExtractionDetails = z.infer<typeof benchmarkExtractionDetailsSchema>;
export type BenchmarkResultItem = z.infer<typeof benchmarkResultItemSchema>;
export type BenchmarkResultItemInput = z.infer<typeof benchmarkResultItemInputSchema>;
export type BenchmarkResultRow = z.infer<typeof benchmarkResultRowSchema>;

/** The stored form of an item a batch sent: the same, with its answer cut to 4,000 characters
 * (`cutBenchmarkAnswer`). */
export function storedBenchmarkItem(item: BenchmarkResultItemInput): BenchmarkResultItem {
  if (item.part !== 'answers' || item.details.answer === null) return item as BenchmarkResultItem;
  const answer = { ...item.details.answer, text: cutBenchmarkAnswer(item.details.answer.text) };
  return { ...item, details: { ...item.details, answer } };
}
