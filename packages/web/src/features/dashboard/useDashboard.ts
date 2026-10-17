// The Home dashboard's data (S8-009, D27 #1), around the generated typed client (D30). The API
// counts only what the person may see and leaves out every section their role can't view (D7, D50,
// D51), so these hooks only fetch and shape what comes back: a tile shows when its section is in
// the answer. The review counts and the frameworks list are their own routes, asked only by the
// roles that may use them (the same cells the API checks), and shared with their own screens' cache.
import { can, canViewReviewQueue } from '@grc/shared';
import { useQuery } from '@tanstack/react-query';
import { api, type GetDashboardResponse } from '@/api/client';
import { frameworkKeys } from '@/features/frameworks/useFrameworks';
import { useReviewCounts } from '@/features/review/useReview';

export type Dashboard = GetDashboardResponse;
export type DashboardRisks = NonNullable<Dashboard['risks']>;
export type DashboardControls = NonNullable<Dashboard['controls']>;
export type DashboardIncidents = NonNullable<Dashboard['incidents']>;
export type DashboardAssets = NonNullable<Dashboard['assets']>;
export type DashboardAuditFindings = NonNullable<Dashboard['auditFindings']>;
export type DashboardEvidence = NonNullable<Dashboard['evidence']>;
export type DashboardDocuments = NonNullable<Dashboard['documents']>;
export type TopRisk = DashboardRisks['top'][number];
export type OpenIncident = DashboardIncidents['newestOpen'][number];

export const dashboardKeys = {
  all: ['dashboard'] as const,
};

/** The dashboard's counts, asked again each time Home opens. */
export function useDashboard() {
  return useQuery({ queryKey: dashboardKeys.all, queryFn: () => api.getDashboard() });
}

/** Whether the role sees the review queue's counts (Admin and Analyst). */
export function seesReviewQueue(role: string | undefined): boolean {
  return role !== undefined && canViewReviewQueue(role);
}

/** How many findings wait for the Analyst; asked only for the roles that see the queue. */
export function useWaitingForReview(role: string | undefined) {
  return useReviewCounts(seesReviewQueue(role));
}

/** Whether the role sees the framework catalogs and their coverage (the Framework-mappings cell). */
export function seesFrameworks(role: string | undefined): boolean {
  return role !== undefined && can(role, 'framework_mapping', 'view');
}

/** Every framework the person can see with its coverage for them, the Frameworks screen's own list. */
export function useFrameworkCoverage(role: string | undefined) {
  return useQuery({
    queryKey: frameworkKeys.list(),
    queryFn: () => api.getFrameworks(),
    enabled: seesFrameworks(role),
  });
}
