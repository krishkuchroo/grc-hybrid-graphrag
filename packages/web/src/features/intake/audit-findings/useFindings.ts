// Audit findings in the web app (S3-014, D202, D213 (2), (4)), around the generated typed client
// (D30): GET /api/v1/controls/:id/audit-findings and /risks/:id/audit-findings (the section on a
// control or risk page), GET, POST, PATCH and retire on /api/v1/audit-findings (the finding's page
// and the add form), and the CONCERNS routes (/audit-findings/:id/concerns, …/concerns/remove).
// Every address is relative (the M0-015 rule). The web only hides what the API would refuse, with
// the S3-002 rules (`canAddFinding`, `canLinkFinding`, `isRemovableLinkOrigin`); the API decides (D7).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  can,
  canAddFinding,
  canLinkFinding,
  defaultLabel,
  FINDING_STATUSES,
  isFindingOverdue,
  isRemovableLinkOrigin,
  isVisible,
  LABELS,
  type AuditFindingRecord,
  type FindingStatus,
  type Label,
} from '@grc/shared';
import {
  api,
  ApiError,
  type GetAuditFindingsIdConcernsResponse,
  type PatchAuditFindingsIdBody,
  type PostAuditFindingsBody,
} from '@/api/client';
import type { Viewer } from '@/features/records/permissions';
import { useMe } from '@/features/records/useRecords';

/** A finding as the API returns it (S3-002's record schema). */
export type Finding = AuditFindingRecord;

/** The record kinds a finding may concern (D67: CONCERNS goes to a control or a risk). */
export const CONCERN_KINDS = ['control', 'risk'] as const;
export type ConcernKind = (typeof CONCERN_KINDS)[number];

/** A control or risk a finding concerns, with the link, as GET …/concerns returns it. */
export type Concern = GetAuditFindingsIdConcernsResponse['items'][number];

/** The plain names of a finding's status (D213 (2)). */
export const FINDING_STATUS_TEXT: Record<FindingStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  remediated: 'Remediated',
  risk_accepted: 'Risk accepted',
  closed: 'Closed',
};

export const FINDING_STATUS_CHOICES = FINDING_STATUSES.map((value) => ({ value, label: FINDING_STATUS_TEXT[value] }));

export function findingStatusText(value: string): string {
  return FINDING_STATUS_TEXT[value as FindingStatus] ?? value;
}

/** What a kind is called on screen. */
export const KIND_NOUN: Record<ConcernKind, string> = { control: 'control', risk: 'risk' };

export const findingKeys = {
  all: ['audit-findings'] as const,
  one: (id: string) => ['audit-findings', 'one', id] as const,
  concerns: (id: string) => ['audit-findings', 'concerns', id] as const,
  concerning: (kind: ConcernKind, id: string) => ['audit-findings', 'concerning', kind, id] as const,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the person's own calendar, as `YYYY-MM-DD`: the day the date rules and overdue use. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayIndex(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** Days from `today` to `date` (negative when it's past), or `null` for a malformed date. */
export function daysUntil(date: string, today: string): number | null {
  const a = dayIndex(today);
  const b = dayIndex(date);
  return a === null || b === null ? null : b - a;
}

/** Overdue (R15): due before today with an open status, per `isFindingOverdue`. */
export function overdue(finding: { dueDate: string; findingStatus: string }, today: string): boolean {
  return isFindingOverdue(finding, today);
}

/** The signed-in person as the access rules take them, or `null` until the shell has asked. */
export function useViewer(): Viewer | null {
  const me = useMe();
  return me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
}

/** Whether the person's role sees audit findings at all (D50: everyone but the Viewer). */
export function mayViewFindings(viewer: Viewer | null): boolean {
  return viewer !== null && can(viewer.role, 'audit_finding', 'view');
}

/** "Add audit finding": only a role that edits findings (the Auditor, D50). */
export function mayAddFinding(viewer: Viewer | null): boolean {
  return viewer !== null && canAddFinding(viewer);
}

/** Edit and Retire on a finding: the role edits findings and the person sees its label. */
export function mayEditFinding(viewer: Viewer | null, finding: { label: string; owner: string }): boolean {
  return (
    viewer !== null &&
    can(viewer.role, 'audit_finding', 'edit', { isOwner: finding.owner === viewer.userId }) &&
    isVisible(viewer.clearance, finding.label)
  );
}

/**
 * A concerned record as `canLinkFinding` needs it. A concern row carries no owner, but the API
 * returns only records the person can see (D51): where the role sees a kind only as its owner (a
 * Control Owner's controls), a row of that kind is one they own. Elsewhere ownership changes
 * nothing, so it's left empty.
 */
export function concernEnd(viewer: Viewer, row: { kind: string; label: string; owner?: string }) {
  if (typeof row.owner === 'string') return { kind: row.kind, label: row.label, owner: row.owner };
  const seenOnlyAsOwner =
    !can(viewer.role, row.kind, 'view', { isOwner: false }) && can(viewer.role, row.kind, 'view', { isOwner: true });
  return { kind: row.kind, label: row.label, owner: seenOnlyAsOwner ? viewer.userId : '' };
}

/** Whether the person may link this finding to that record (D200, S3-002's `canLinkFinding`). */
export function mayLinkTo(
  viewer: Viewer | null,
  finding: { label: string; owner: string },
  other: { kind: string; label: string; owner?: string },
): boolean {
  return viewer !== null && canLinkFinding(viewer, finding, concernEnd(viewer, other));
}

/** Whether "Link a control or risk" shows: some control or risk the person could see would pass. */
export function mayLinkAny(viewer: Viewer | null, finding: { label: string; owner: string }): boolean {
  if (viewer === null) return false;
  return CONCERN_KINDS.some((kind) => canLinkFinding(viewer, finding, { kind, label: 'public', owner: viewer.userId }));
}

/** "Remove" on a concern row: the person may link the two (D201) and the link isn't an AI one (D207). */
export function mayRemoveConcern(viewer: Viewer | null, finding: { label: string; owner: string }, row: Concern) {
  return isRemovableLinkOrigin(row.origin) && mayLinkTo(viewer, finding, row);
}

/** The labels a new finding may get: none above the person's clearance (D198). */
export function findingLabelChoices(viewer: Viewer): Label[] {
  return LABELS.filter((label) => isVisible(viewer.clearance, label));
}

/** A new finding's starting label: the D51 default (`internal`), or the clearance if that's lower. */
export function startingFindingLabel(viewer: Viewer): Label {
  const wanted = defaultLabel('audit_finding');
  const choices = findingLabelChoices(viewer);
  if (choices.includes(wanted)) return wanted;
  return choices[choices.length - 1] ?? wanted;
}

// ---- Queries -------------------------------------------------------------------------------

/** The active findings concerning a control or risk the person can see. Nothing is asked for a
 * role that never sees findings. */
export function useConcerningFindings(kind: ConcernKind, id: string, enabled: boolean) {
  return useQuery({
    queryKey: findingKeys.concerning(kind, id),
    queryFn: async (): Promise<Finding[]> => {
      const answer =
        kind === 'control' ? await api.getControlsIdAuditFindings({ id }) : await api.getRisksIdAuditFindings({ id });
      return answer.items as Finding[];
    },
    enabled,
  });
}

export function useFinding(id: string) {
  return useQuery({
    queryKey: findingKeys.one(id),
    queryFn: async (): Promise<Finding> => (await api.getAuditFindingsId({ id })) as Finding,
  });
}

export function useFindingConcerns(id: string, enabled = true) {
  return useQuery({
    queryKey: findingKeys.concerns(id),
    queryFn: async (): Promise<Concern[]> => (await api.getAuditFindingsIdConcerns({ id })).items,
    enabled,
  });
}

// ---- Changes -------------------------------------------------------------------------------

/** After any change to a finding, its page and every findings section ask the API again. */
function useSettle() {
  const queryClient = useQueryClient();
  return async (finding: Finding) => {
    queryClient.setQueryData(findingKeys.one(finding.id), finding);
    await queryClient.invalidateQueries({ queryKey: findingKeys.all });
  };
}

/** Records a finding with the control or risk it concerns (R11): one request makes both. */
export function useCreateFinding() {
  const settle = useSettle();
  return useMutation({
    mutationFn: async (body: PostAuditFindingsBody): Promise<Finding> => (await api.postAuditFindings(body)) as Finding,
    onSuccess: settle,
  });
}

export function useUpdateFinding(id: string) {
  const settle = useSettle();
  return useMutation({
    mutationFn: async (body: PatchAuditFindingsIdBody): Promise<Finding> =>
      (await api.patchAuditFindingsId({ id }, body)) as Finding,
    onSuccess: settle,
  });
}

export function useRetireFinding(id: string) {
  const settle = useSettle();
  return useMutation({
    mutationFn: async (version: number): Promise<Finding> =>
      (await api.postAuditFindingsIdRetire({ id }, { version })) as Finding,
    onSuccess: settle,
  });
}

/** The API's refusals that mean the concerns on screen are out of date: a record or link that is
 * gone or hidden (404), a link already there (409 `link_exists`), or an AI link only the Analyst
 * may remove (409 `ai_link_review_only`, D207). */
export function concernRefusalMeansStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'link_exists' || error.code === 'ai_link_review_only')
  );
}

/** Asks again for the finding's concerns and every findings section (the other end's among them). */
function useRefreshConcerns() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: findingKeys.all });
}

/** Links the finding to another control or risk it concerns. */
export function useAddConcern(findingId: string) {
  const refresh = useRefreshConcerns();
  return useMutation({
    mutationFn: (toId: string) => api.postAuditFindingsIdConcerns({ id: findingId }, { toId }),
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      if (concernRefusalMeansStale(error)) await refresh();
    },
  });
}

/** Removes a CONCERNS link added by mistake (D201); the API keeps the last one (R11). */
export function useRemoveConcern(findingId: string) {
  const refresh = useRefreshConcerns();
  return useMutation({
    mutationFn: (toId: string) => api.postAuditFindingsIdConcernsRemove({ id: findingId }, { toId }),
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      if (concernRefusalMeansStale(error)) await refresh();
    },
  });
}

export function isLastConcern(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'last_concern';
}

/** What the page says for the API's `last_concern` refusal (R11). */
export const LAST_CONCERN_TEXT = 'A finding must concern at least one control or risk.';
