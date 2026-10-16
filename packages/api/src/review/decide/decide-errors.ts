// The refusals of an Analyst's decision (S5-003; D47), in the one error format with a reference ID:
// S5-001's review error codes with their status and plain message, and the shared 403 and 404s.
// No message holds a record's name, a sentence or a note.
import { REVIEW_ERRORS, type ReviewErrorCode } from '@grc/shared';
import { ApiError } from '../../common/errors.js';

/** One of S5-001's review errors (for example 409 `already_decided`). */
export function reviewError(code: ReviewErrorCode): ApiError {
  const { status, message } = REVIEW_ERRORS[code];
  return new ApiError(status, code, message);
}

/** A finding that is missing, another org's, or above the reader's clearance: all the same (D47). */
export const FINDING_NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The finding was not found.');

/** A record a finding names that is missing or that the Analyst can't see now. */
export const RECORD_NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');

export const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You do not have permission to do this.');

/** A decision is a person's judgement (D24, D45.6): an API key never makes one. */
export const PEOPLE_ONLY = (): ApiError =>
  new ApiError(403, 'forbidden', 'Only a person can decide on a review finding, not an API key.');
