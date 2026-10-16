// What an answer may cite (S6 shared notes, "Context" and "Messages and labels"): each source has one
// number, `[1]`, `[2]`…, in fused order across both context sections, and is either a record (ID,
// number, name and kind) or a passage (its chunk, its document's ID, name and kind, its place and
// its text). A message's label is the highest label among the sources given to Gemma for it, Public
// when there are none (D51, planner's reading S6-Q9).
import { z } from 'zod';
import { LABELS, isLabel, type Label } from '../access/labels.js';
import { DOCUMENT_KINDS } from '../intake/uploads.js';
import { searchRecordNumberSchema } from './answers.js';
import { SEARCH_RECORD_KINDS } from './kinds.js';

/** A source's number, from 1. */
export const sourceNumberSchema = z.int().min(1);

export const sourceRecordSchema = z.object({
  id: z.uuid(),
  number: searchRecordNumberSchema,
  name: z.string(),
  kind: z.enum(SEARCH_RECORD_KINDS),
});

export const sourcePassageSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentName: z.string(),
  documentKind: z.enum(DOCUMENT_KINDS),
  /** The chunk's place in its document, from 0. */
  position: z.int().min(0),
  text: z.string(),
});

export const recordSourceSchema = z.object({
  number: sourceNumberSchema,
  type: z.literal('record'),
  record: sourceRecordSchema,
});

export const passageSourceSchema = z.object({
  number: sourceNumberSchema,
  type: z.literal('passage'),
  passage: sourcePassageSchema,
});

/** One source an answer may cite. */
export const answerSourceSchema = z.discriminatedUnion('type', [recordSourceSchema, passageSourceSchema]);

export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type SourcePassage = z.infer<typeof sourcePassageSchema>;
export type RecordSource = z.infer<typeof recordSourceSchema>;
export type PassageSource = z.infer<typeof passageSourceSchema>;
export type AnswerSource = z.infer<typeof answerSourceSchema>;

/** The highest of the labels; Public when there are none. Anything that isn't a label counts as
 * Restricted, so an unknown label hides more, never less (fail safe). */
export function highestLabel(labels: Iterable<Label | string>): Label {
  let highest = 0;
  for (const label of labels) {
    const rank = isLabel(label) ? LABELS.indexOf(label) : LABELS.length - 1;
    if (rank > highest) highest = rank;
  }
  return LABELS[highest] ?? 'restricted';
}
