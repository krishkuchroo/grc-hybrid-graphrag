// TanStack Query hooks for the Frameworks screen (D27 #7), around the generated typed client (D30).
// Every call goes through `@/api/client` with its relative /api/v1 addresses (the M0-015 rule).
// The API decides what each person sees and counts (D7, D51): a hidden control neither shows nor
// counts, so these hooks only fetch, cache and shape what comes back. Coverage is only ever the
// API's SATISFIES answer, never a control's Source note (D212 (5)).
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FRAMEWORKS, isFrameworkKey } from '@grc/shared';
import {
  api,
  type GetFrameworksIdRequirementsResponse,
  type GetFrameworksResponse,
  type GetRequirementsIdResponse,
  type ListQuery,
} from '@/api/client';

/** One framework with its counts for the signed-in person. */
export type FrameworkSummary = GetFrameworksResponse['items'][number];
/** One row of a framework's requirements table, with its coverage for the signed-in person. */
export type RequirementRow = GetFrameworksIdRequirementsResponse['items'][number];
/** One requirement with the controls that satisfy it and its links to other frameworks. */
export type RequirementDetail = GetRequirementsIdResponse;
export type SatisfyingControl = RequirementDetail['controls'][number];
export type RelatedRequirement = RequirementDetail['mapsTo'][number];

export const frameworkKeys = {
  all: ['frameworks'] as const,
  list: () => ['frameworks', 'list'] as const,
  one: (id: string) => ['frameworks', 'one', id] as const,
  requirements: (id: string, query: ListQuery) => ['frameworks', 'one', id, 'requirements', query] as const,
  requirement: (id: string) => ['frameworks', 'requirement', id] as const,
  parent: (frameworkId: string, code: string) => ['frameworks', 'one', frameworkId, 'parent', code] as const,
};

/** Every active framework the person can see, each with its counts for them. */
export function useFrameworks() {
  return useQuery({ queryKey: frameworkKeys.list(), queryFn: () => api.getFrameworks() });
}

/**
 * One framework with its counts. When the list has already been shown, its row starts the page
 * straight away (and the API is asked again in the background), so the requirements table doesn't
 * wait for a second round trip.
 */
export function useFramework(id: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: frameworkKeys.one(id),
    queryFn: () => api.getFrameworksId({ id }),
    initialData: () =>
      queryClient.getQueryData<GetFrameworksResponse>(frameworkKeys.list())?.items.find((f) => f.id === id),
    initialDataUpdatedAt: () => queryClient.getQueryState(frameworkKeys.list())?.dataUpdatedAt,
  });
}

/** One page of a framework's requirements, with the filters sent to the API (D47). */
export function useRequirementList(frameworkId: string, query: ListQuery) {
  return useQuery({
    queryKey: frameworkKeys.requirements(frameworkId, query),
    queryFn: () => api.getFrameworksIdRequirements({ id: frameworkId }, query),
    placeholderData: keepPreviousData,
  });
}

export function useRequirement(id: string) {
  return useQuery({ queryKey: frameworkKeys.requirement(id), queryFn: () => api.getRequirementsId({ id }) });
}

/** The most rows one list request may ask for (the API's page-size limit). */
const LOOKUP_PAGE_SIZE = 100;

/**
 * The base control of an 800-53 enhancement, as the API answers it: its own framework's
 * requirements searched for the parent's code, then the exact code picked out. A parent the person
 * can't see comes back as `null`, so the page shows its code without a link.
 */
export function useParentRequirement(frameworkId: string | undefined, parentCode: string | null) {
  return useQuery({
    queryKey: frameworkKeys.parent(frameworkId ?? '', parentCode ?? ''),
    enabled: frameworkId !== undefined && parentCode !== null,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RequirementRow | null> => {
      const answer = await api.getFrameworksIdRequirements(
        { id: frameworkId! },
        { q: parentCode!, status: 'all', pageSize: LOOKUP_PAGE_SIZE },
      );
      return answer.items.find((r) => r.code === parentCode) ?? null;
    },
  });
}

// ---- How framework values read on screen --------------------------------------------------------

/** The framework's name as shown (`NIST SP 800-53`), from the shared catalog list, else the key. */
export function frameworkName(key: string): string {
  return isFrameworkKey(key) ? FRAMEWORKS[key].name : key;
}

/** A framework's groups in the order it publishes them, as `{ value: 'AC', label: 'AC Access Control' }`. */
export function groupChoices(key: string): Array<{ value: string; label: string }> {
  if (!isFrameworkKey(key)) return [];
  return Object.entries(FRAMEWORKS[key].groupNames).map(([code, name]) => ({ value: code, label: `${code} ${name}` }));
}

/** A requirement's group as shown: `AC Access Control`, `GV.OC Organizational Context`. */
export function groupLabel(key: string, group: string): string {
  const name = isFrameworkKey(key) ? FRAMEWORKS[key].groupNames[group] : undefined;
  return name ? `${group} ${name}` : group;
}

/** An 800-53 enhancement's base control code, or `null` (the API sends `null` for every other code). */
export function parentCodeOf(requirement: { parentCode: unknown }): string | null {
  return typeof requirement.parentCode === 'string' && requirement.parentCode.trim() !== ''
    ? requirement.parentCode
    : null;
}
