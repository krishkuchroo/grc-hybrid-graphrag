// A record's related records and the "Add link" dialog, around the generated typed client (D30):
// GET /api/v1/<plural>/:id/links, the other end's list route with `q`, POST /api/v1/links and
// POST /api/v1/links/remove. The API decides every permission and returns only links whose other
// end the person can see (D7, D51); these hooks only fetch, cache and refresh.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecordKind } from '@grc/shared';
import {
  api,
  ApiError,
  type GetRisksIdLinksResponse,
  type PostLinksBody,
  type PostLinksRemoveBody,
} from '@/api/client';
import { recordKeys, type AnyRecord, type Paged } from '../useRecords';

export type RecordLink = GetRisksIdLinksResponse['items'][number];

const LINKS: Record<RecordKind, (path: { id: string }) => Promise<GetRisksIdLinksResponse>> = {
  risk: api.getRisksIdLinks,
  control: api.getControlsIdLinks,
  policy: api.getPoliciesIdLinks,
  asset: api.getAssetsIdLinks,
  incident: api.getIncidentsIdLinks,
};

const SEARCH: Record<RecordKind, (query: { q: string; pageSize: number }) => Promise<Paged<AnyRecord>>> = {
  risk: api.getRisks,
  control: api.getControls,
  policy: api.getPolicies,
  asset: api.getAssets,
  incident: api.getIncidents,
};

/** How many records the dialog shows for one search. */
export const SEARCH_PAGE = 20;

const linksKey = (kind: RecordKind, id: string) => [...recordKeys.all(kind), 'links', id] as const;

export function useRecordLinks(kind: RecordKind, id: string) {
  return useQuery({ queryKey: linksKey(kind, id), queryFn: () => LINKS[kind]({ id }) });
}

/** One kind's list, searched by name or number. Nothing is asked until there's text to search. */
export function useLinkSearch(kind: RecordKind, q: string) {
  return useQuery({
    queryKey: [...recordKeys.all(kind), 'link-search', q] as const,
    queryFn: () => SEARCH[kind]({ q, pageSize: SEARCH_PAGE }),
    enabled: q !== '',
  });
}

/** Adds a link, then asks again for the links of both ends. */
export function useAddLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: PostLinksBody; ends: Array<{ kind: RecordKind; id: string }> }) =>
      api.postLinks(vars.body),
    onSuccess: async (_saved, vars) => {
      await Promise.all(
        vars.ends.map((end) => queryClient.invalidateQueries({ queryKey: linksKey(end.kind, end.id) })),
      );
    },
  });
}

type LinkEnd = { kind: RecordKind; id: string };

/** The API's refusals that mean the group on screen is out of date: the link is gone or hidden
 * (404), or it's an AI link only the Analyst may remove (409 `ai_link_review_only`, D207). */
export function removalMeansStale(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'ai_link_review_only');
}

/** Removes a link (D201), then asks again for the links of both ends; also after a refusal that
 * means the group on screen is out of date. */
export function useRemoveLink() {
  const queryClient = useQueryClient();
  const refresh = (ends: LinkEnd[]) =>
    Promise.all(ends.map((end) => queryClient.invalidateQueries({ queryKey: linksKey(end.kind, end.id) })));
  return useMutation({
    mutationFn: (vars: { body: PostLinksRemoveBody; ends: LinkEnd[] }) => api.postLinksRemove(vars.body),
    onSuccess: async (_removed, vars) => {
      await refresh(vars.ends);
    },
    onError: async (error, vars) => {
      if (removalMeansStale(error)) await refresh(vars.ends);
    },
  });
}
