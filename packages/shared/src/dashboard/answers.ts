// The Home dashboard's answer (S8-008, D27 #1, D30, D47), shared by `GET /api/v1/dashboard` and the
// web app. Every count holds only active records the person may see (D50, D51); a section is left
// out when the role doesn't view its record type (`dashboardSections`), never sent as zeros.
// - risks: the count, per band (D197), the 5 x 5 heat map (one cell per impact x likelihood, all
//   25 always present), the risks with no MITIGATED_BY link to an active control the person can
//   see, and the top 5 by rating, then financial exposure.
// - controls: per status, and the share implemented (`null` with no controls).
// - incidents: open ones (not resolved or closed) per severity, and the 5 newest open.
// - assets: per criticality. policies: the count.
// - auditFindings: open ones (open or in progress) per severity, and how many are past their due
//   date (`isFindingOverdue`).
// - evidence: how many expire within EXPIRING_SOON_DAYS days, today included, and how many have
//   expired (`evidenceValidity`).
// - documents: the stored documents the person may see, per processing status.
// - countedAt: when the counts were taken. Dates are compared with that day in UTC.
import { z } from 'zod';
import { FINDING_SEVERITIES } from '../intake/audit-findings.js';
import { DOCUMENT_STATUSES } from '../intake/statuses.js';
import { CONTROL_STATUSES, CRITICALITIES, INCIDENT_SEVERITIES } from '../records/values.js';
import {
  DASHBOARD_NEWEST_INCIDENTS,
  DASHBOARD_RISK_BANDS,
  DASHBOARD_TOP_RISKS,
  OPEN_INCIDENT_STATUSES,
} from './sections.js';

const count = z.int().min(0);
const recordNumber = z.string().regex(/^[A-Z]{3}\d{7}$/);
const scale = z.int().min(1).max(5);

/** One count per value of a fixed list, every value always present. */
function countsOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.strictObject(Object.fromEntries(values.map((v) => [v, count])) as Record<T[number], typeof count>);
}

export const dashboardHeatCellSchema = z.strictObject({ impact: scale, likelihood: scale, count });

export const dashboardTopRiskSchema = z.strictObject({
  id: z.uuid(),
  number: recordNumber,
  name: z.string(),
  impact: scale,
  likelihood: scale,
  /** impact x likelihood (D197). */
  rating: z.int().min(1).max(25),
  band: z.enum(DASHBOARD_RISK_BANDS),
});

export const dashboardRisksSchema = z.strictObject({
  total: count,
  byBand: countsOf(DASHBOARD_RISK_BANDS),
  heatMap: z.array(dashboardHeatCellSchema).length(25),
  untreated: count,
  top: z.array(dashboardTopRiskSchema).max(DASHBOARD_TOP_RISKS),
});

export const dashboardControlsSchema = z.strictObject({
  total: count,
  byStatus: countsOf(CONTROL_STATUSES),
  implementedShare: z.number().min(0).max(1).nullable(),
});

export const dashboardIncidentSchema = z.strictObject({
  id: z.uuid(),
  number: recordNumber,
  name: z.string(),
  severity: z.enum(INCIDENT_SEVERITIES),
  incidentStatus: z.enum(OPEN_INCIDENT_STATUSES),
  /** When it happened, as stored (an ISO date-time). */
  occurredAt: z.string(),
});

export const dashboardIncidentsSchema = z.strictObject({
  open: count,
  openBySeverity: countsOf(INCIDENT_SEVERITIES),
  newestOpen: z.array(dashboardIncidentSchema).max(DASHBOARD_NEWEST_INCIDENTS),
});

export const dashboardAssetsSchema = z.strictObject({ total: count, byCriticality: countsOf(CRITICALITIES) });

export const dashboardPoliciesSchema = z.strictObject({ total: count });

export const dashboardAuditFindingsSchema = z.strictObject({
  open: count,
  openBySeverity: countsOf(FINDING_SEVERITIES),
  overdue: count,
});

export const dashboardEvidenceSchema = z.strictObject({ expiringSoon: count, expired: count });

export const dashboardDocumentsSchema = z.strictObject({ total: count, byStatus: countsOf(DOCUMENT_STATUSES) });

export const dashboardSchema = z.strictObject({
  countedAt: z.iso.datetime({ offset: true }),
  risks: dashboardRisksSchema.optional(),
  controls: dashboardControlsSchema.optional(),
  incidents: dashboardIncidentsSchema.optional(),
  assets: dashboardAssetsSchema.optional(),
  policies: dashboardPoliciesSchema.optional(),
  auditFindings: dashboardAuditFindingsSchema.optional(),
  evidence: dashboardEvidenceSchema.optional(),
  documents: dashboardDocumentsSchema.optional(),
});

export type DashboardHeatCell = z.infer<typeof dashboardHeatCellSchema>;
export type DashboardTopRisk = z.infer<typeof dashboardTopRiskSchema>;
export type DashboardRisks = z.infer<typeof dashboardRisksSchema>;
export type DashboardControls = z.infer<typeof dashboardControlsSchema>;
export type DashboardIncident = z.infer<typeof dashboardIncidentSchema>;
export type DashboardIncidents = z.infer<typeof dashboardIncidentsSchema>;
export type DashboardAssets = z.infer<typeof dashboardAssetsSchema>;
export type DashboardPolicies = z.infer<typeof dashboardPoliciesSchema>;
export type DashboardAuditFindings = z.infer<typeof dashboardAuditFindingsSchema>;
export type DashboardEvidence = z.infer<typeof dashboardEvidenceSchema>;
export type DashboardDocuments = z.infer<typeof dashboardDocumentsSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
