// What an Analyst's decision made or removed (D38, D69; S5 shared notes, "Statuses"): the shape of
// `review_findings.outcome`, per kind, by record ID and number only (never a name, a sentence or
// Gemma's reason). Empty until a decision; a rejection makes nothing, so it leaves it empty.
// - link and mapping: the link written (`created`), or one already there of the same type between
//   the same two records in the same direction (`exists`, nothing written).
// - record: the new record.
// - duplicate: the record kept and the one retired into it.
// After a removal the same object carries `removed.graph`: for a link or mapping, whether the AI
// link was `deleted` or `not_found`; for a record, whether it was `retired` or `already_retired`
// (records are retired, never deleted, D69). A duplicate merge is never removed.
import { z } from 'zod';
import { MAPPING_LINK_TYPES, type MappingLinkType } from '../frameworks/frameworks.js';
import { EXTRACTION_LINK_TYPES } from '../processing/extraction.js';
import type { ReviewFindingKind } from '../processing/findings.js';

const recordNumber = z.string().regex(/^[A-Z]{3}\d{7}$/);

/** Whether approving wrote the link, or found it already there. */
export const LINK_OUTCOME_RESULTS = ['created', 'exists'] as const;
export type LinkOutcomeResult = (typeof LINK_OUTCOME_RESULTS)[number];

/** What a removal did in the graph. */
export const REMOVAL_GRAPH_RESULTS = ['deleted', 'not_found', 'retired', 'already_retired'] as const;
export type RemovalGraphResult = (typeof REMOVAL_GRAPH_RESULTS)[number];

/** A link or mapping is deleted (or wasn't found); a record is retired (or already was). */
export const linkRemovalSchema = z.strictObject({ graph: z.enum(['deleted', 'not_found']) });
export const recordRemovalSchema = z.strictObject({ graph: z.enum(['retired', 'already_retired']) });

const linkEnds = {
  fromId: z.uuid(),
  fromNumber: recordNumber,
  toId: z.uuid(),
  toNumber: recordNumber,
};

const MAPPING_TYPES = MAPPING_LINK_TYPES.map((row) => row.type) as [MappingLinkType, ...MappingLinkType[]];

export const linkOutcomeSchema = z.strictObject({
  result: z.enum(LINK_OUTCOME_RESULTS),
  type: z.enum(EXTRACTION_LINK_TYPES),
  ...linkEnds,
  removed: linkRemovalSchema.optional(),
});

export const mappingOutcomeSchema = z.strictObject({
  result: z.enum(LINK_OUTCOME_RESULTS),
  type: z.enum(MAPPING_TYPES),
  ...linkEnds,
  removed: linkRemovalSchema.optional(),
});

export const recordOutcomeSchema = z.strictObject({
  recordId: z.uuid(),
  number: recordNumber,
  removed: recordRemovalSchema.optional(),
});

export const duplicateOutcomeSchema = z
  .strictObject({
    keptId: z.uuid(),
    keptNumber: recordNumber,
    retiredId: z.uuid(),
    retiredNumber: recordNumber,
  })
  .refine((o) => o.keptId !== o.retiredId, { path: ['retiredId'], message: 'a record is not merged into itself' });

/** Each kind's outcome schema. */
export const outcomeSchemas = {
  link: linkOutcomeSchema,
  record: recordOutcomeSchema,
  duplicate: duplicateOutcomeSchema,
  mapping: mappingOutcomeSchema,
} as const satisfies Record<ReviewFindingKind, z.ZodType>;

/** Any kind's outcome. */
export const reviewOutcomeSchema = z.union([
  linkOutcomeSchema,
  recordOutcomeSchema,
  duplicateOutcomeSchema,
  mappingOutcomeSchema,
]);

export type LinkOutcome = z.infer<typeof linkOutcomeSchema>;
export type MappingOutcome = z.infer<typeof mappingOutcomeSchema>;
export type RecordOutcome = z.infer<typeof recordOutcomeSchema>;
export type DuplicateOutcome = z.infer<typeof duplicateOutcomeSchema>;
export type LinkRemoval = z.infer<typeof linkRemovalSchema>;
export type RecordRemoval = z.infer<typeof recordRemovalSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
export type OutcomeOf<K extends ReviewFindingKind> = z.infer<(typeof outcomeSchemas)[K]>;
