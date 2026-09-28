// What the records screens offer, from the D50 role table and the D51 labels in @grc/shared.
// The web only hides buttons and choices it knows the API would refuse; the API decides (D7).
import { can, canChangeLabel, defaultLabel, isVisible, LABELS, type Label, type RecordKind } from '@grc/shared';

export interface Viewer {
  userId: string;
  role: string;
  clearance: string;
}

/** Edit and Retire on a record: `edit`, or `edit_own` on a record the person owns. */
export function canEditRecord(viewer: Viewer, kind: RecordKind, record?: { owner: string }): boolean {
  return can(viewer.role, kind, 'edit', { isOwner: record !== undefined && record.owner === viewer.userId });
}

/** A new record needs full edit on the kind: owning nothing yet, `edit_own` isn't enough (D199). */
export function canCreateRecord(viewer: Viewer, kind: RecordKind): boolean {
  return can(viewer.role, kind, 'edit');
}

/** The labels a new record may get: none above the person's clearance (D198). */
export function createLabelChoices(viewer: Viewer): Label[] {
  return LABELS.filter((label) => isVisible(viewer.clearance, label));
}

/** The labels an edit may set: the changes canChangeLabel allows, none above the clearance (D51, D198). */
export function editLabelChoices(viewer: Viewer, from: Label): Label[] {
  return LABELS.filter((to) => isVisible(viewer.clearance, to) && canChangeLabel(viewer.role, from, to));
}

/** A new record's starting label: the kind's default, or the clearance if that's lower. */
export function startingLabel(viewer: Viewer, kind: RecordKind): Label {
  const wanted = defaultLabel(kind);
  const choices = createLabelChoices(viewer);
  if (choices.includes(wanted)) return wanted;
  return choices[choices.length - 1] ?? wanted;
}
