// The "Not reviewed yet" list of a chat answer (D260, Q-ASK-1 and Q-ASK-5): the pending link
// findings that match the question, built by our code from the review queue (never by the model),
// shown only to the roles that can open the queue (Admin and Analyst, D50), each as the queue shows
// it, with labels checked against the reader's clearance (D51).
// - An item: the finding's ID and current status, its link type, its two ends as the queue's list
//   shows them, and its source sentence and document only where the queue's detail would show them
//   (`null` otherwise).
// - The list: at most 50 items, newest first, the number of matches in all (`total`, at least the
//   item count, so the panel can say "Showing N of M"), and the one document every match comes from
//   when there is one the reader may read (`null` otherwise).
// - A message saves only the finding IDs, the total and the document ID; opening the conversation
//   reads the findings again with the reader's access now.
import { z } from 'zod';
import { EXTRACTION_LINK_TYPES } from '../processing/extraction.js';
import { REVIEW_FINDING_STATUSES } from '../processing/findings.js';
import { linkEndSummarySchema, reviewSourceDocumentSchema } from '../review/answers.js';
import { SEARCH_LIMITS } from '../search/limits.js';

/** One pending link finding in the "Not reviewed yet" list. */
export const chatPendingLinkSchema = z.object({
  findingId: z.uuid(),
  /** Its status now: `pending` when the answer was written, possibly decided since. */
  status: z.enum(REVIEW_FINDING_STATUSES),
  type: z.enum(EXTRACTION_LINK_TYPES),
  from: linkEndSummarySchema,
  to: linkEndSummarySchema,
  /** The source sentence, only with a chunk the reader may read. */
  sentence: z.string().nullable(),
  /** The source document, only when the reader may read it. */
  document: reviewSourceDocumentSchema.nullable(),
});

/** The "Not reviewed yet" list of a message; `null` on the message for a role that can't open the
 * review queue. */
export const chatPendingLinksSchema = z
  .object({
    items: z.array(chatPendingLinkSchema).max(SEARCH_LIMITS.pendingLinks),
    /** Every match, listed or not. */
    total: z.int().min(0),
    /** The one document every match comes from, when the reader may read it. */
    documentId: z.uuid().nullable(),
  })
  .refine((list) => list.total >= list.items.length, { path: ['total'], message: 'below the item count' });

export type ChatPendingLink = z.infer<typeof chatPendingLinkSchema>;
export type ChatPendingLinks = z.infer<typeof chatPendingLinksSchema>;
