// Who may add, see, change and review evidence (D50 "Evidence files", D213 (3), D220 (4)), and who
// may add and link audit findings (D50 "Audit findings", D200): pure functions for the API and the
// web app. "Label visible" means the label is at or below the caller's clearance (D51). Anything
// unknown (role, clearance, label, kind or caller) is refused (fail safe, D45.7).
import { isLabel, isVisible } from '../access/labels.js';
import { ROLE_TABLE, can } from '../access/role-table.js';
import { isRole, type Role } from '../access/roles.js';
import { isAllowedIntakeLink } from './intake-links.js';

export interface IntakeCaller {
  userId: string;
  role: string;
  clearance: string;
}

function knownCaller(caller: IntakeCaller): boolean {
  return (
    typeof caller.userId === 'string' && caller.userId.length > 0 && isRole(caller.role) && isLabel(caller.clearance)
  );
}

function labelVisible(caller: IntakeCaller, label: unknown): boolean {
  return isLabel(label) && isVisible(caller.clearance, label);
}

/** The Admin adds to any control whose label they can see; the Control Owner only to a control
 * they own whose label they can see; everyone else never. */
export function canAddEvidence(caller: IntakeCaller, control: { label: string; owner: string }): boolean {
  if (!knownCaller(caller) || !labelVisible(caller, control.label)) return false;
  const isOwner = control.owner === caller.userId;
  if (!can(caller.role, 'control', 'view', { isOwner })) return false;
  if (!can(caller.role, 'uploads', 'use', { recordType: 'evidence' })) return false;
  return can(caller.role, 'evidence', 'edit') || can(caller.role, 'evidence', 'upload', { isOwner });
}

/** The evidence's label must be visible; then the Admin, Risk Manager, Compliance Manager, Auditor
 * and Analyst see it; the Control Owner only when they own a control it supports, whoever added it;
 * the Viewer never. `supportedControlOwners` are the owners of the controls it supports. */
export function canSeeEvidence(
  caller: IntakeCaller,
  evidence: { label: string },
  supportedControlOwners: readonly string[],
): boolean {
  if (!knownCaller(caller) || !labelVisible(caller, evidence.label)) return false;
  if (!Array.isArray(supportedControlOwners)) return false;
  const isOwner = supportedControlOwners.includes(caller.userId);
  return can(caller.role, 'evidence', 'view', { isOwner });
}

/** Edit and retire: the caller sees it, and is the Admin, or the Control Owner who added it. */
export function canEditEvidence(
  caller: IntakeCaller,
  evidence: { label: string; createdBy: string },
  supportedControlOwners: readonly string[],
): boolean {
  if (!canSeeEvidence(caller, evidence, supportedControlOwners)) return false;
  if (can(caller.role, 'evidence', 'edit')) return true;
  // The Control Owner's `upload_own` cell: only evidence they added themselves.
  return ROLE_TABLE.evidence[caller.role as Role] === 'upload_own' && evidence.createdBy === caller.userId;
}

/** The roles that accept or reject evidence (D220 (4)): the Admin and the Compliance Manager. */
export const EVIDENCE_REVIEWER_ROLES: readonly Role[] = ['admin', 'compliance_manager'];

/** Accept or reject (D213 (2), D220 (4)): the caller sees the evidence, is an Admin or a Compliance
 * Manager, and didn't add it themselves. A missing or malformed `createdBy` is refused. */
export function canReviewEvidence(
  caller: IntakeCaller,
  evidence: { label: string; createdBy: string },
  supportedControlOwners: readonly string[],
): boolean {
  if (!canSeeEvidence(caller, evidence, supportedControlOwners)) return false;
  if (!EVIDENCE_REVIEWER_ROLES.includes(caller.role as Role)) return false;
  const addedBy: unknown = evidence.createdBy;
  return typeof addedBy === 'string' && addedBy.length > 0 && addedBy !== caller.userId;
}

/** Only a role that edits audit findings adds them (the Auditor). */
export function canAddFinding(caller: IntakeCaller): boolean {
  return knownCaller(caller) && can(caller.role, 'audit_finding', 'edit');
}

/** Link a finding to a control or risk it concerns (and remove such a link, with
 * `isRemovableLinkOrigin`, D207): the caller edits the finding, sees its label, and sees the
 * other end (its type for their role, with ownership, and its label). */
export function canLinkFinding(
  caller: IntakeCaller,
  finding: { label: string; owner?: string },
  other: { kind: string; label: string; owner?: string },
): boolean {
  if (!knownCaller(caller)) return false;
  if (!can(caller.role, 'audit_finding', 'edit', { isOwner: finding.owner === caller.userId })) return false;
  if (!labelVisible(caller, finding.label)) return false;
  if (!isAllowedIntakeLink('CONCERNS', 'audit_finding', other.kind)) return false;
  return (
    can(caller.role, other.kind, 'view', { isOwner: other.owner === caller.userId }) &&
    labelVisible(caller, other.label)
  );
}
