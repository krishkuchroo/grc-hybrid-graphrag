// TanStack Query hooks for the five record kinds, around the generated typed client (D30). Every
// call goes through `@/api/client` with its relative /api/v1 addresses (the M0-015 rule).
// The API decides every permission (D7); these hooks only fetch, cache and refresh.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Label, RecordKind } from '@grc/shared';
import { api, ApiError, type GetMeResponse, type ListQuery } from '@/api/client';
import { ME_KEY } from '@/features/auth/session';

/** The fields every record has, as the API returns them (the S1 shared notes). */
export interface BaseRecord {
  id: string;
  number: string;
  sourceIds: string[];
  name: string;
  label: Label;
  status: 'active' | 'retired';
  owner: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  origin: 'manual' | 'import' | 'ai';
}

export type AnyRecord = BaseRecord & Record<string, unknown>;

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** The five routes of one kind. Method syntax, so each kind's own body types fit. */
interface KindApi {
  list(query?: ListQuery): Promise<Paged<AnyRecord>>;
  get(path: { id: string }): Promise<AnyRecord>;
  create(body: never): Promise<AnyRecord>;
  update(path: { id: string }, body: never): Promise<AnyRecord>;
  retire(path: { id: string }, body: { version: number }): Promise<AnyRecord>;
}

const CLIENT: Record<RecordKind, KindApi> = {
  risk: {
    list: api.getRisks,
    get: api.getRisksId,
    create: api.postRisks,
    update: api.patchRisksId,
    retire: api.postRisksIdRetire,
  },
  control: {
    list: api.getControls,
    get: api.getControlsId,
    create: api.postControls,
    update: api.patchControlsId,
    retire: api.postControlsIdRetire,
  },
  policy: {
    list: api.getPolicies,
    get: api.getPoliciesId,
    create: api.postPolicies,
    update: api.patchPoliciesId,
    retire: api.postPoliciesIdRetire,
  },
  asset: {
    list: api.getAssets,
    get: api.getAssetsId,
    create: api.postAssets,
    update: api.patchAssetsId,
    retire: api.postAssetsIdRetire,
  },
  incident: {
    list: api.getIncidents,
    get: api.getIncidentsId,
    create: api.postIncidents,
    update: api.patchIncidentsId,
    retire: api.postIncidentsIdRetire,
  },
};

export const recordKeys = {
  all: (kind: RecordKind) => ['records', kind] as const,
  list: (kind: RecordKind, query: ListQuery) => ['records', kind, 'list', query] as const,
  one: (kind: RecordKind, id: string) => ['records', kind, 'one', id] as const,
};

export const PEOPLE_KEY = ['people'] as const;

/** The signed-in person; the shell has already asked, so this reads the cache. */
export function useMe() {
  return useQuery<GetMeResponse>({ queryKey: ME_KEY, queryFn: () => api.getMe(), staleTime: Infinity });
}

/** One page of a kind's list, with the paging, sort and filters sent to the API (D47). */
export function useRecordList(kind: RecordKind, query: ListQuery) {
  return useQuery({
    queryKey: recordKeys.list(kind, query),
    queryFn: () => CLIENT[kind].list(query),
    placeholderData: keepPreviousData,
  });
}

export function useRecord(kind: RecordKind, id: string) {
  return useQuery({ queryKey: recordKeys.one(kind, id), queryFn: () => CLIENT[kind].get({ id }) });
}

export interface Person {
  id: string;
  name: string;
  role: string;
}

const PEOPLE_PAGE = 100;

/** Every member of the org, for owner names and the owner picker (all pages of GET /api/v1/people). */
export function usePeople() {
  return useQuery({
    queryKey: PEOPLE_KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Person[]> => {
      const people: Person[] = [];
      for (let page = 1; ; page += 1) {
        const answer = await api.getPeople({ page, pageSize: PEOPLE_PAGE });
        people.push(...answer.items);
        if (answer.items.length === 0 || people.length >= answer.total) return people;
      }
    },
  });
}

/**
 * After any change, every list and page of the kind asks the API again. When the saved record is
 * one the person can no longer see (a Control Owner handing their control to someone else, D206),
 * nothing is asked again now: the page would only get the not-found answer. The lists are marked
 * out of date and ask again when they next show.
 */
function useSettle(kind: RecordKind, keepsAccess?: (record: AnyRecord) => boolean) {
  const queryClient = useQueryClient();
  return async (record: AnyRecord) => {
    queryClient.setQueryData(recordKeys.one(kind, record.id), record);
    const refetchType = keepsAccess && !keepsAccess(record) ? 'none' : 'active';
    await queryClient.invalidateQueries({ queryKey: recordKeys.all(kind), refetchType });
  };
}

export function useCreateRecord(kind: RecordKind) {
  const settle = useSettle(kind);
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => CLIENT[kind].create(body as never),
    onSuccess: settle,
  });
}

export function useUpdateRecord(
  kind: RecordKind,
  id: string,
  opts: { keepsAccess?: (record: AnyRecord) => boolean } = {},
) {
  const settle = useSettle(kind, opts.keepsAccess);
  return useMutation({
    mutationFn: (body: Record<string, unknown> & { version: number }) => CLIENT[kind].update({ id }, body as never),
    onSuccess: settle,
  });
}

export function useRetireRecord(kind: RecordKind, id: string) {
  const settle = useSettle(kind);
  return useMutation({
    mutationFn: (version: number) => CLIENT[kind].retire({ id }, { version }),
    onSuccess: settle,
  });
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function isStale(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'stale_version';
}
