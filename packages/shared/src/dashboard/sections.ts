// The Home dashboard's sections (S8-008, D27 #1, D50, D51): the record type each section counts,
// which sections a role gets, and the readings the counts use. Pure: no I/O, no clock.
// - A section is in the answer only when the role views its record type (D50). An "own" cell
//   (`edit_own`, `upload_own`) counts as viewing, limited to the person's own records, the same as
//   their lists. A role that can't view the type gets no section at all, never a zero.
// - The documents section follows the Uploads cell instead (`can(role, 'uploads', 'use')`), the
//   same rule as `GET /api/v1/documents`.
import { can, type RecordType } from '../access/role-table.js';
import type { RiskBand } from '../records/rating.js';
import type { IncidentStatus } from '../records/values.js';

export const DASHBOARD_SECTIONS = [
  'risks',
  'controls',
  'incidents',
  'assets',
  'policies',
  'auditFindings',
  'evidence',
  'documents',
] as const;
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

/** The sections counted from the graph, and the D50 row each one follows. */
export type DashboardGraphSection = Exclude<DashboardSection, 'documents'>;

export const DASHBOARD_SECTION_RECORD_TYPES = Object.freeze({
  risks: 'risk',
  controls: 'control',
  incidents: 'incident',
  assets: 'asset',
  policies: 'policy',
  auditFindings: 'audit_finding',
  evidence: 'evidence',
} as const satisfies Record<DashboardGraphSection, RecordType>);

/** The risk bands (D197), low to critical. */
export const DASHBOARD_RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly RiskBand[];

/** An open incident is one not resolved or closed. */
export const OPEN_INCIDENT_STATUSES = [
  'new',
  'investigating',
  'contained',
] as const satisfies readonly IncidentStatus[];
export type OpenIncidentStatus = (typeof OPEN_INCIDENT_STATUSES)[number];

/** How many risks the top list holds, and how many incidents the newest-open list holds. */
export const DASHBOARD_TOP_RISKS = 5;
export const DASHBOARD_NEWEST_INCIDENTS = 5;

/** Whether a role gets a section: it views the section's record type (an "own" cell included), or,
 * for documents, it has the Uploads cell. Unknown roles get nothing (fail safe). */
export function hasDashboardSection(role: string, section: DashboardSection): boolean {
  if (section === 'documents') return can(role, 'uploads', 'use');
  return can(role, DASHBOARD_SECTION_RECORD_TYPES[section], 'view', { isOwner: true });
}

/** The sections a role gets, in the answer's order. */
export function dashboardSections(role: string): DashboardSection[] {
  return DASHBOARD_SECTIONS.filter((section) => hasDashboardSection(role, section));
}
