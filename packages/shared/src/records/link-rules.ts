// Who may add a link between two records (D200): one pure function for the API and the web app.
// A person may link two records when they can edit either of them (the D50 `edit` cell, or
// `edit_own` on a control they own) and can see both (the role may view the type, a Control Owner
// owns any control end, and the label is at or below their clearance, D51). Anything unknown is
// refused (fail safe, D45.7).
import { isLabel, isVisible } from '../access/labels.js';
import { can } from '../access/role-table.js';
import { isRole } from '../access/roles.js';
import { isRecordKind } from './types.js';

export interface LinkCaller {
  userId: string;
  role: string;
  clearance: string;
}

export interface LinkRecordEnd {
  kind: string;
  label: string;
  owner: string;
}

function known(end: LinkRecordEnd): boolean {
  return isRecordKind(end.kind) && isLabel(end.label);
}

function sees(caller: LinkCaller, end: LinkRecordEnd): boolean {
  const isOwner = end.owner === caller.userId;
  return can(caller.role, end.kind, 'view', { isOwner }) && isVisible(caller.clearance, end.label);
}

function edits(caller: LinkCaller, end: LinkRecordEnd): boolean {
  return can(caller.role, end.kind, 'edit', { isOwner: end.owner === caller.userId });
}

export function canLinkRecords(caller: LinkCaller, from: LinkRecordEnd, to: LinkRecordEnd): boolean {
  if (!isRole(caller.role) || !isLabel(caller.clearance) || !known(from) || !known(to)) return false;
  if (!sees(caller, from) || !sees(caller, to)) return false;
  return edits(caller, from) || edits(caller, to);
}

/** The link origins `POST /api/v1/links/remove` may remove (D207). An `ai` link is removed only
 * through the Analyst's review. */
export const REMOVABLE_LINK_ORIGINS = ['manual', 'import'] as const;

export type RemovableLinkOrigin = (typeof REMOVABLE_LINK_ORIGINS)[number];

/** True for exactly `manual` and `import` (D207); anything else, `ai` included, is refused. */
export function isRemovableLinkOrigin(origin: unknown): origin is RemovableLinkOrigin {
  return typeof origin === 'string' && (REMOVABLE_LINK_ORIGINS as readonly string[]).includes(origin);
}
