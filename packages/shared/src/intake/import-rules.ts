// Who may import asset lists that create or change assets (D213 (5), planner's reading R14): the
// Admin, Risk Managers, Compliance Managers and Analysts. It applies the same way to people and to
// API keys (a key's one role, D54). The one place this rule lives.

export const IMPORT_ROLES = ['admin', 'risk_manager', 'compliance_manager', 'analyst'] as const;
export type ImportRole = (typeof IMPORT_ROLES)[number];

/** True exactly for the four import roles; the Control Owner, Auditor, Viewer and unknown roles are refused. */
export function canImportAssets(role: string): boolean {
  return (IMPORT_ROLES as readonly string[]).includes(role);
}
