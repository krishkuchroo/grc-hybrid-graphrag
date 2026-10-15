// The links Evidence and Audit findings bring (D67): Evidence -SUPPORTS-> Control, and
// AuditFinding -CONCERNS-> Control or Risk, each in its one direction.
import type { RecordKind } from '../records/types.js';
import type { IntakeRecordKind } from './intake-numbers.js';

export const INTAKE_LINK_TYPES = [
  { type: 'SUPPORTS', from: 'evidence', to: 'control' },
  { type: 'CONCERNS', from: 'audit_finding', to: 'control' },
  { type: 'CONCERNS', from: 'audit_finding', to: 'risk' },
] as const satisfies readonly { type: string; from: IntakeRecordKind; to: RecordKind }[];

export type IntakeLinkType = (typeof INTAKE_LINK_TYPES)[number]['type'];

/** True for exactly the three rows above, in their direction. */
export function isAllowedIntakeLink(type: unknown, fromKind: unknown, toKind: unknown): boolean {
  return INTAKE_LINK_TYPES.some((row) => row.type === type && row.from === fromKind && row.to === toKind);
}
