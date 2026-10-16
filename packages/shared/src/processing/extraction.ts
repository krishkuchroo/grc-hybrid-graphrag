// The extraction answer (D39, D52.4, D67; S4 shared notes, "The extraction answer"): what Gemma must
// give for one chunk. S4-006 asks for it, S4-008 reads it. A list of records (a short reference, one
// of the five kinds, the name exactly as written, optional plain details) and a list of links (one of
// the 7 spec types, the references of its two ends, and the one sentence that states it, word for
// word). The schema refuses unknown fields, unknown kinds and link types, a link whose end isn't one
// of the answer's records, and anything past the caps. The link's direction is not checked here: the
// `ontology_fit` rule check decides that, so a wrong direction waits for the Analyst. The lenient
// reader keeps every valid item and drops and counts the rest, so one bad item doesn't lose the chunk.
import { z } from 'zod';
import { LINK_TYPES, type LinkType } from '../records/links.js';
import { RECORD_KINDS } from '../records/types.js';

export const EXTRACTION_LIMITS = Object.freeze({
  /** Records in one answer. */
  records: 50,
  /** Links in one answer. */
  links: 50,
  /** A reference: letters, digits, `_` and `-`. */
  refLength: 40,
  /** A name, exactly as written in the text. */
  nameLength: 200,
  /** A link's sentence, copied word for word. */
  sentenceLength: 1000,
  /** Entries in a record's details. */
  detailEntries: 10,
  /** A detail's key: a letter, then letters, digits and `_`. */
  detailKeyLength: 40,
  /** A detail's value. */
  detailValueLength: 200,
});

/** The 7 spec link types (`LINK_TYPES`), as a list of names. */
export const EXTRACTION_LINK_TYPES = LINK_TYPES.map((row) => row.type) as [LinkType, ...LinkType[]];

const ref = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${EXTRACTION_LIMITS.refLength}}$`));

function text(max: number) {
  return z.string().min(1).max(max).regex(/\S/, 'must not be blank');
}

/** A name exactly as written in the text: 1 to 200 characters, not blank. */
export const extractedNameSchema = text(EXTRACTION_LIMITS.nameLength);

/** A sentence copied word for word: 1 to 1,000 characters, not blank. */
export const extractedSentenceSchema = text(EXTRACTION_LIMITS.sentenceLength);

/** A small flat map of short strings, for example `{ severity: "High" }` as written. */
export const extractedDetailsSchema = z
  .record(
    z.string().regex(new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${EXTRACTION_LIMITS.detailKeyLength - 1}}$`)),
    text(EXTRACTION_LIMITS.detailValueLength),
  )
  .refine((details) => Object.keys(details).length <= EXTRACTION_LIMITS.detailEntries, {
    message: `at most ${EXTRACTION_LIMITS.detailEntries} details`,
  });

export const extractionRecordSchema = z.strictObject({
  ref,
  kind: z.enum(RECORD_KINDS),
  name: extractedNameSchema,
  details: extractedDetailsSchema.optional(),
});

export const extractionLinkSchema = z.strictObject({
  type: z.enum(EXTRACTION_LINK_TYPES),
  from: ref,
  to: ref,
  sentence: extractedSentenceSchema,
});

export const extractionAnswerSchema = z
  .strictObject({
    records: z.array(extractionRecordSchema).max(EXTRACTION_LIMITS.records),
    links: z.array(extractionLinkSchema).max(EXTRACTION_LIMITS.links),
  })
  .superRefine((answer, ctx) => {
    const refs = new Set<string>();
    answer.records.forEach((record, i) => {
      if (refs.has(record.ref)) {
        ctx.addIssue({ code: 'custom', path: ['records', i, 'ref'], message: 'reference used twice' });
      }
      refs.add(record.ref);
    });
    answer.links.forEach((link, i) => {
      for (const end of ['from', 'to'] as const) {
        if (!refs.has(link[end])) {
          ctx.addIssue({ code: 'custom', path: ['links', i, end], message: 'not a record of this answer' });
        }
      }
    });
  });

export type ExtractionRecord = z.infer<typeof extractionRecordSchema>;
export type ExtractionLink = z.infer<typeof extractionLinkSchema>;
export type ExtractionAnswer = z.infer<typeof extractionAnswerSchema>;

export interface ExtractionReadResult {
  /** False when nothing in the answer could be read: it isn't an object holding a `records` or
   * `links` list (each one a list when given), or it gave items and every one was dropped. An
   * answer with two empty lists is readable: the chunk states nothing. */
  readable: boolean;
  /** The kept items; always passes `extractionAnswerSchema`. */
  answer: ExtractionAnswer;
  droppedRecords: number;
  droppedLinks: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unreadable(): ExtractionReadResult {
  return { readable: false, answer: { records: [], links: [] }, droppedRecords: 0, droppedLinks: 0 };
}

/** A list's items: none when it isn't given, `null` when it's given but isn't a list. */
function itemsOf(v: unknown): unknown[] | null {
  if (v === undefined) return [];
  return Array.isArray(v) ? (v as unknown[]) : null;
}

/**
 * Reads an answer leniently (D52.4). A record is kept when it passes `extractionRecordSchema`, its
 * reference isn't one an earlier kept record has, and fewer than 50 records are kept so far. A link is
 * kept when it passes `extractionLinkSchema`, both its ends are kept records, and fewer than 50 links
 * are kept so far. Everything else is dropped and counted; fields beside `records` and `links` are
 * ignored.
 */
export function readExtractionAnswer(raw: unknown): ExtractionReadResult {
  if (!isPlainObject(raw) || (raw.records === undefined && raw.links === undefined)) return unreadable();
  const recordItems = itemsOf(raw.records);
  const linkItems = itemsOf(raw.links);
  if (recordItems === null || linkItems === null) return unreadable();

  const records: ExtractionRecord[] = [];
  const refs = new Set<string>();
  for (const item of recordItems) {
    const parsed = extractionRecordSchema.safeParse(item);
    if (!parsed.success || refs.has(parsed.data.ref) || records.length >= EXTRACTION_LIMITS.records) continue;
    refs.add(parsed.data.ref);
    records.push(parsed.data);
  }

  const links: ExtractionLink[] = [];
  for (const item of linkItems) {
    const parsed = extractionLinkSchema.safeParse(item);
    if (!parsed.success || links.length >= EXTRACTION_LIMITS.links) continue;
    if (!refs.has(parsed.data.from) || !refs.has(parsed.data.to)) continue;
    links.push(parsed.data);
  }

  const given = recordItems.length + linkItems.length;
  const kept = records.length + links.length;
  return {
    readable: given === 0 || kept > 0,
    answer: { records, links },
    droppedRecords: recordItems.length - records.length,
    droppedLinks: linkItems.length - links.length,
  };
}
