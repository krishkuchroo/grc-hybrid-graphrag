// Who may use the review queue and what may happen to a finding (D24, D38, D50, D207; S5 shared
// notes, "Who" and "Statuses"). Read from ROLE_TABLE, never hard-coded: the Admin's Review-queue
// cell is `view` (the queue and every detail, read-only), the Analyst's is `work` (the only role that
// approves, rejects or removes), and approving a suggested mapping also needs the Framework-mappings
// `approve` cell. Anything unknown is refused (fail safe, D45.7).
import { can } from '../access/role-table.js';
import {
  isReviewFindingKind,
  isReviewFindingStatus,
  type ReviewFindingKind,
  type ReviewFindingStatus,
} from '../processing/findings.js';

/** Whether the role may see the review queue and its findings (Admin and Analyst). */
export function canViewReviewQueue(role: string): boolean {
  return can(role, 'review_queue', 'view');
}

/** Whether the role may approve, reject or remove findings (the Analyst only). */
export function canWorkReviewQueue(role: string): boolean {
  return can(role, 'review_queue', 'work');
}

/** Whether the role may approve a finding of this kind: it works the queue, and for a suggested
 * mapping it also has the Framework-mappings `approve` cell. */
export function canApproveFinding(role: string, kind: string): boolean {
  if (!isReviewFindingKind(kind) || !canWorkReviewQueue(role)) return false;
  return kind !== 'mapping' || can(role, 'framework_mapping', 'approve');
}

/** Only a `pending` finding is approved or rejected. `live` ones were made live by the rule checks
 * and can only be removed; `approved`, `rejected` and `removed` never go back. */
export function canDecide(status: string): boolean {
  return status === 'pending';
}

/** The statuses from which a finding of each kind can be removed (D38, D207): a live or approved
 * link or mapping, and an approved new record. A duplicate merge can't be removed or undone. */
export const REMOVABLE_STATUSES: Readonly<Record<ReviewFindingKind, readonly ReviewFindingStatus[]>> = Object.freeze({
  link: Object.freeze(['live', 'approved'] as const),
  record: Object.freeze(['approved'] as const),
  duplicate: Object.freeze([] as const),
  mapping: Object.freeze(['live', 'approved'] as const),
});

/** Whether a finding of this kind and status can be removed (taken back out of the graph). */
export function canRemove(kind: string, status: string): boolean {
  if (!isReviewFindingKind(kind) || !isReviewFindingStatus(status)) return false;
  return REMOVABLE_STATUSES[kind].includes(status);
}
