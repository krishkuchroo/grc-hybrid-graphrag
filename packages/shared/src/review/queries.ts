// The review queue's list query (D47; S5 shared notes): paged like every other list, with the
// filters S5-002 narrows by. Query-string values arrive as text, so numbers are coerced, and unknown
// filters or values are refused (a ZodError, answered as 400).
// - kind: one finding kind.
// - status: one or more statuses, as `status=pending,live` or a repeated `status`; `pending` when
//   none is given.
// - documentId: the source document.
// - recordId: any record the finding names: an end, a candidate, the duplicate pair, the mapping
//   ends, or the record its approval created.
// - failedCheck: one of the three rule checks.
// - sort: `newest` (the default) or `oldest`, by when the finding was made.
import { z } from 'zod';
import { REVIEW_FINDING_KINDS, REVIEW_FINDING_STATUSES, type ReviewFindingStatus } from '../processing/findings.js';
import { RULE_CHECKS } from '../processing/rule-checks.js';

export const REVIEW_SORTS = ['newest', 'oldest'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/** The list's paging, as other lists page (D47). */
export const REVIEW_DEFAULT_PAGE_SIZE = 25;
export const REVIEW_MAX_PAGE_SIZE = 100;

/** When no status is asked for, the list shows the findings that wait for the Analyst. */
export const REVIEW_DEFAULT_STATUSES: readonly ReviewFindingStatus[] = Object.freeze(['pending'] as const);

/** `a,b` and repeated values as one list: each part trimmed, empty parts dropped, repeats once. */
function listOf(value: unknown): unknown {
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v: unknown) =>
    typeof v === 'string' ? v.split(',').map((p) => p.trim()) : [v],
  );
  return [...new Set(parts.filter((p) => p !== ''))];
}

const statuses = z
  .preprocess(listOf, z.array(z.enum(REVIEW_FINDING_STATUSES)).min(1).max(REVIEW_FINDING_STATUSES.length))
  .default([...REVIEW_DEFAULT_STATUSES]);

export const reviewListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(REVIEW_MAX_PAGE_SIZE).default(REVIEW_DEFAULT_PAGE_SIZE),
  sort: z.enum(REVIEW_SORTS).default('newest'),
  kind: z.enum(REVIEW_FINDING_KINDS).optional(),
  status: statuses,
  documentId: z.uuid().toLowerCase().optional(),
  recordId: z.uuid().toLowerCase().optional(),
  failedCheck: z.enum(RULE_CHECKS).optional(),
});

export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

/** Checks a list query (a ZodError, answered as 400, for anything unknown or malformed). */
export function parseReviewListQuery(query: unknown): ReviewListQuery {
  return reviewListQuerySchema.parse(query ?? {});
}
