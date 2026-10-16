// The review decisions' names (D47, D56, D186; S5 shared notes, "Audit" and "Error codes"): the audit
// actions S5 writes in Postgres, the target type of a decision entry, and the error codes with their
// HTTP status and a plain message. Messages never hold a record's name, a sentence or a note.
// - `review.approved`, `review.rejected` and `review.removed` target the finding; their meta holds the
//   kind, the old and new status, the finding's label and the outcome's record numbers, and the
//   entry holds the Analyst's note.
// - `document.removed` targets the document (D52.5); its meta holds the counts.
// The graph changes keep their own entries (`link.created`, `link.removed`, `record.created`,
// `record.merged`, `record.retired`, `record.updated`).

export const REVIEW_AUDIT_ACTIONS = Object.freeze({
  approved: 'review.approved',
  rejected: 'review.rejected',
  removed: 'review.removed',
  documentRemoved: 'document.removed',
} as const);

export type ReviewAuditAction = (typeof REVIEW_AUDIT_ACTIONS)[keyof typeof REVIEW_AUDIT_ACTIONS];

/** The `targetType` of a decision's entry; its `targetId` is the finding's ID. */
export const REVIEW_FINDING_TARGET_TYPE = 'review_finding';

/** The `targetType` of a whole-upload removal's entry; its `targetId` is the document's ID. */
export const REVIEW_DOCUMENT_TARGET_TYPE = 'document';

export interface ReviewError {
  status: 400 | 409;
  message: string;
}

/** Each S5 error code, its status and its plain message (D47's one error format adds a reference ID). */
export const REVIEW_ERRORS = Object.freeze({
  /** The finding isn't pending, or for removal isn't live or approved. */
  already_decided: { status: 409, message: 'This finding has already been decided.' },
  /** The kind or status can't be removed. */
  not_removable: { status: 409, message: "This finding can't be removed." },
  /** An uncertain end needs one of its candidates. */
  end_not_chosen: { status: 400, message: 'Choose which record each uncertain end of the link means.' },
  /** The record chosen isn't one of that end's candidates. */
  end_not_candidate: { status: 400, message: "The record chosen isn't one of that end's candidates." },
  /** The proposed new record this end points to hasn't been approved yet. */
  end_not_approved: { status: 409, message: 'Approve the proposed record this link points to first.' },
  /** That proposed record was rejected. */
  end_rejected: { status: 409, message: 'The proposed record this link points to was rejected.' },
  /** A record is retired or merged away. */
  record_not_active: { status: 409, message: 'A record in this finding is retired or merged into another.' },
  /** The type and direction don't fit the ontology. */
  link_not_allowed: { status: 400, message: "This kind of link doesn't fit these records." },
  /** The document is more sensitive than both ends allow. */
  source_above_ends: {
    status: 409,
    message: 'The document is more sensitive than these records allow, so this link can only be rejected.',
  },
  /** The new record's label is below the document's. */
  label_below_source: { status: 400, message: "The new record's label can't be lower than the document's." },
} as const satisfies Record<string, ReviewError>);

export type ReviewErrorCode = keyof typeof REVIEW_ERRORS;

export const REVIEW_ERROR_CODES = Object.freeze(Object.keys(REVIEW_ERRORS) as ReviewErrorCode[]);

export function isReviewErrorCode(v: unknown): v is ReviewErrorCode {
  return typeof v === 'string' && Object.hasOwn(REVIEW_ERRORS, v);
}
