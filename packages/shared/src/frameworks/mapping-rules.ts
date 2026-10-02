// Who may add or remove a control-to-requirement mapping (D50 "Framework mappings" row, D51,
// D212 (3)): one pure function for the API and the web app. Only a role whose Framework-mappings
// cell is `edit` (Admin, Compliance Manager) may map, and only a control they can see (its label at
// or below their clearance). Owning the control grants nothing: the Framework-mappings row wins
// over D200's owner rule, so `canLinkRecords` is not used here. Anything unknown is refused (fail
// safe, D45.7).
import { isLabel, isVisible } from '../access/labels.js';
import { can } from '../access/role-table.js';
import { isRole } from '../access/roles.js';

export interface MappingCaller {
  userId: string;
  role: string;
  clearance: string;
}

export interface MappedControl {
  label: string;
  owner: string;
}

export function canMapControl(caller: MappingCaller, control: MappedControl): boolean {
  if (!caller || !control) return false;
  const { userId, role, clearance } = caller;
  if (!isRole(role) || !isLabel(clearance) || !isLabel(control.label)) return false;
  if (!can(role, 'framework_mapping', 'edit')) return false;
  const isOwner = typeof userId === 'string' && userId !== '' && control.owner === userId;
  return can(role, 'control', 'view', { isOwner }) && isVisible(clearance, control.label);
}
