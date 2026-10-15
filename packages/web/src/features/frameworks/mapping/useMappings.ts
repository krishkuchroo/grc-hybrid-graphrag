// Control-to-requirement mappings in the web app (S2-007, D212 (3)), around the generated typed
// client (D30): GET /api/v1/controls/:id/requirements, the two pickers' searches (GET
// /api/v1/controls?q=… and GET /api/v1/frameworks/:id/requirements?q=…), POST /api/v1/mappings and
// POST /api/v1/mappings/remove. Every address is relative (the M0-015 rule). The web only hides the
// buttons the API would refuse (`canMapControl`, `isRemovableLinkOrigin`); the API decides (D7).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can, canMapControl, isRemovableLinkOrigin } from '@grc/shared';
import {
  api,
  ApiError,
  type GetControlsIdRequirementsResponse,
  type GetControlsResponse,
  type PostMappingsBody,
  type PostMappingsRemoveBody,
} from '@/api/client';
import type { Viewer } from '@/features/records/permissions';
import { useMe } from '@/features/records/useRecords';
import { frameworkKeys } from '../useFrameworks';

/** One requirement a control satisfies, as GET /api/v1/controls/:id/requirements returns it. */
export type ControlRequirement = GetControlsIdRequirementsResponse['items'][number];
/** One control found by the "Map a control" search. */
export type ControlHit = GetControlsResponse['items'][number];

/** How many items a picker shows for one search. */
export const PICKER_PAGE = 20;

/** How long typing must pause before a picker's search is asked. */
export const SEARCH_PAUSE_MS = 200;

export const mappingKeys = {
  /** Under the frameworks key, so a change to a mapping refreshes coverage everywhere with it. */
  controlRequirements: (controlId: string) => [...frameworkKeys.all, 'control', controlId, 'requirements'] as const,
  controlSearch: (q: string) => [...frameworkKeys.all, 'mapping', 'control-search', q] as const,
  requirementSearch: (frameworkId: string, q: string) =>
    [...frameworkKeys.all, 'mapping', 'requirement-search', frameworkId, q] as const,
};

/** The signed-in person as the access rules take them, or `null` until the shell has asked. */
export function useViewer(): Viewer | null {
  const me = useMe();
  return me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
}

/** Whether the person's role may add and remove mappings at all: the Framework-mappings `edit`
 * cell (D50: Admin and Compliance Manager). Which controls they may map is `canMapControl`. */
export function mayMapAny(viewer: Viewer | null): boolean {
  return viewer !== null && can(viewer.role, 'framework_mapping', 'edit');
}

/**
 * A control as `canMapControl` needs it. A requirement's control rows carry no owner, but the API
 * returns only controls the person can see (D51): where the role sees controls only as their owner
 * (`edit_own`), a row is one they own. Elsewhere ownership changes nothing, so it's left empty.
 */
export function mappedControlOf(viewer: Viewer, control: { label: string; owner?: string }) {
  if (typeof control.owner === 'string') return { label: control.label, owner: control.owner };
  const seenOnlyAsOwner =
    !can(viewer.role, 'control', 'view', { isOwner: false }) && can(viewer.role, 'control', 'view', { isOwner: true });
  return { label: control.label, owner: seenOnlyAsOwner ? viewer.userId : '' };
}

/** Whether the person may map this control (D212 (3)). */
export function mayMapControl(viewer: Viewer | null, control: { label: string; owner?: string }): boolean {
  return viewer !== null && canMapControl(viewer, mappedControlOf(viewer, control));
}

/** Whether a mapping row gets "Remove": the person may map its control and the mapping isn't one
 * the AI suggested (D207: those go only through the Analyst's review, Admins included). */
export function mayRemoveMapping(
  viewer: Viewer | null,
  control: { label: string; owner?: string },
  origin: unknown,
): boolean {
  return isRemovableLinkOrigin(origin) && mayMapControl(viewer, control);
}

/** The requirements a control satisfies, in framework then natural code order (the API's order). */
export function useControlRequirements(controlId: string) {
  return useQuery({
    queryKey: mappingKeys.controlRequirements(controlId),
    queryFn: () => api.getControlsIdRequirements({ id: controlId }),
  });
}

/** Controls found by name or number. Nothing is asked until there's text to search. */
export function useControlSearch(q: string) {
  return useQuery({
    queryKey: mappingKeys.controlSearch(q),
    queryFn: () => api.getControls({ q, pageSize: PICKER_PAGE }),
    enabled: q !== '',
  });
}

/** One framework's active requirements found by code or title. Nothing is asked until a framework
 * is chosen and there's text to search. */
export function useRequirementSearch(frameworkId: string, q: string) {
  return useQuery({
    queryKey: mappingKeys.requirementSearch(frameworkId, q),
    queryFn: () => api.getFrameworksIdRequirements({ id: frameworkId }, { q, pageSize: PICKER_PAGE }),
    enabled: frameworkId !== '' && q !== '',
  });
}

/** The API's refusals that mean what's on screen is out of date: a control, requirement or
 * mapping that is gone or hidden (404), a mapping already there (409 `link_exists`), or an AI
 * mapping only the Analyst may remove (409 `ai_link_review_only`, D207). */
export function mappingRefusalMeansStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'link_exists' || error.code === 'ai_link_review_only')
  );
}

/** Asks again for everything a mapping shows in: the requirement's controls, the control's
 * requirements, and every framework's coverage. */
function useRefreshMappings() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: frameworkKeys.all });
}

/** Records that a control satisfies a requirement, then refreshes both sides. */
export function useAddMapping() {
  const refresh = useRefreshMappings();
  return useMutation({
    mutationFn: (body: PostMappingsBody) => api.postMappings(body),
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      if (mappingRefusalMeansStale(error)) await refresh();
    },
  });
}

/** Takes a mapping back, then refreshes both sides; also after a refusal that means the screen is
 * out of date. */
export function useRemoveMapping() {
  const refresh = useRefreshMappings();
  return useMutation({
    mutationFn: (body: PostMappingsRemoveBody) => api.postMappingsRemove(body),
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      if (mappingRefusalMeansStale(error)) await refresh();
    },
  });
}
