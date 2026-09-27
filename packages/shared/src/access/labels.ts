// Sensitivity labels and clearance (D51). A record is visible only if the role allows its type
// and the user's clearance is at or above its label. A link is visible only if both ends are.
import { can, isEditor } from './role-table.js';
import { isRole } from './roles.js';

/** Ordered low to high. */
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

export type Label = (typeof LABELS)[number];

export function isLabel(value: unknown): value is Label {
  return typeof value === 'string' && (LABELS as readonly string[]).includes(value);
}

function rank(label: Label): number {
  return LABELS.indexOf(label);
}

/** Clearance at or above the label. Unknown values are refused. */
export function isVisible(clearance: Label | string, label: Label | string): boolean {
  if (!isLabel(clearance) || !isLabel(label)) return false;
  return rank(clearance) >= rank(label);
}

export interface Viewer {
  role: string;
  clearance: Label | string;
}

export interface LinkEnd {
  recordType: string;
  label: Label | string;
  isOwner?: boolean;
}

/** Visible by type (the D50 table, with ownership) and by label. */
export function isRecordVisible(viewer: Viewer, end: LinkEnd): boolean {
  return (
    can(viewer.role, end.recordType, 'view', { isOwner: end.isOwner === true }) &&
    isVisible(viewer.clearance, end.label)
  );
}

/** A link is visible only if both of its ends are visible. */
export function isLinkVisible(viewer: Viewer, from: LinkEnd, to: LinkEnd): boolean {
  return isRecordVisible(viewer, from) && isRecordVisible(viewer, to);
}

/** Assets take their data classification, incidents and evidence are confidential, all else internal. */
export function defaultLabel(recordType: string, attrs?: { dataClassification?: Label }): Label {
  if (recordType === 'asset') {
    const classification = attrs?.dataClassification;
    return isLabel(classification) ? classification : 'internal';
  }
  if (recordType === 'incident' || recordType === 'evidence') return 'confidential';
  return 'internal';
}

/** Editors may raise a label. Only an admin may lower one. */
export function canChangeLabel(role: string, from: Label | string, to: Label | string): boolean {
  if (!isRole(role) || !isLabel(from) || !isLabel(to)) return false;
  if (rank(to) > rank(from)) return isEditor(role);
  if (rank(to) < rank(from)) return role === 'admin';
  return true;
}
