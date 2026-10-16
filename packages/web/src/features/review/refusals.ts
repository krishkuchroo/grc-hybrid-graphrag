// A refused review action in plain words (S5-005, S5-006; D47): approving, rejecting, removing a
// false positive and removing a whole upload. The API's code and reference ID are kept, so support
// can find the log line; the S5 codes use S5-001's shared messages, and 403 and 404 get the
// screen's own words.
import { isReviewErrorCode, REVIEW_ERRORS, type ReviewFindingKind } from '@grc/shared';
import { ApiError } from '@/api/client';

/** What the Analyst asked for: approve or reject a waiting finding, remove a live or approved one
 * as a false positive, or remove everything from one upload. */
export type DecisionAction = 'approve' | 'reject' | 'remove' | 'remove_upload';

function forbiddenText(action: DecisionAction, kind: ReviewFindingKind | undefined): string {
  if (action === 'remove' || action === 'remove_upload') {
    return 'Only an Analyst can remove findings or uploads. Your role can see the queue but not change it.';
  }
  if (action === 'approve' && kind === 'mapping') {
    return 'Only an Analyst with the right to approve framework mappings can approve a suggested mapping.';
  }
  if (action === 'approve' && kind === 'record') {
    return 'The record can’t be created as it is: its label can’t be above your clearance, and only an Analyst approves proposed records.';
  }
  return 'Only an Analyst can approve or reject findings. Your role can see the queue but not decide.';
}

/**
 * A refused action in plain words, keeping the API's code and reference ID. An upload of a kind
 * that can't be removed keeps the API's own words, which say which kinds can. `kind` is the
 * finding's kind, for every action but removing an upload.
 */
export function decisionRefusal(error: unknown, action: DecisionAction, kind?: ReviewFindingKind): ApiError | unknown {
  if (!(error instanceof ApiError)) return error;
  let message = error.message;
  if (isReviewErrorCode(error.code) && !(action === 'remove_upload' && error.code === 'not_removable')) {
    message = REVIEW_ERRORS[error.code].message;
  } else if (error.status === 403) {
    message = forbiddenText(action, kind);
  } else if (error.status === 404) {
    message =
      action === 'remove_upload'
        ? 'This upload doesn’t exist or you can’t see it.'
        : 'This finding, or a record it names, doesn’t exist or you can’t see it.';
  } else if (error.code === 'validation_failed') {
    message =
      action === 'approve' && kind === 'record'
        ? 'The new record’s details weren’t accepted. Check each field, then approve it again.'
        : 'The decision couldn’t be read. A note can be up to 1,000 characters.';
  }
  return new ApiError(error.status, error.code, message, error.referenceId);
}

/** The title over a refused action. */
export function decisionRefusalTitle(action: DecisionAction, kind?: ReviewFindingKind): string {
  switch (action) {
    case 'approve':
      if (kind === 'record') return 'The record wasn’t created';
      if (kind === 'duplicate') return 'The records weren’t merged';
      return 'The finding wasn’t approved';
    case 'reject':
      return kind === 'duplicate' ? 'The records weren’t marked as not duplicates' : 'The finding wasn’t rejected';
    case 'remove':
      return 'The finding wasn’t removed';
    case 'remove_upload':
      return 'The upload wasn’t removed';
  }
}
