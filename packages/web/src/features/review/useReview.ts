// The Analyst review screen's data (S5-005, S5-006, D27 #8), around the generated typed client
// (D30): the queue (GET /api/v1/review/findings), one finding (GET /api/v1/review/findings/:id), the
// waiting counts (GET /api/v1/review/counts), approving and rejecting (POST …/:id/approve and
// …/:id/reject), removing a false positive (POST …/:id/remove), what one upload put in and removing
// all of it (GET /api/v1/review/documents/:id and POST …/:id/remove), and the names the filters show
// (GET /api/v1/documents/:id and a record kind's list). Every address is relative (the M0-015 rule).
// The API decides every permission and what each person sees (D7, D50, D51); these hooks fetch,
// cache and refresh.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RECORD_KINDS,
  REVIEW_DEFAULT_PAGE_SIZE,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_STATUSES,
  type RecordKind,
  type ReviewFindingKind,
  type ReviewFindingStatus,
} from '@grc/shared';
import {
  api,
  ApiError,
  type GetReviewDocumentsIdResponse,
  type GetReviewFindingsIdResponse,
  type GetReviewFindingsResponse,
  type ListQuery,
  type PostReviewDocumentsIdRemoveResponse,
  type PostReviewFindingsIdApproveBody,
  type PostReviewFindingsIdApproveResponse,
  type PostReviewFindingsIdRejectResponse,
  type PostReviewFindingsIdRemoveResponse,
} from '@/api/client';
import { frameworkKeys } from '@/features/frameworks/useFrameworks';
import { intakeKeys } from '@/features/intake/useDocuments';
import type { AnyRecord, Paged } from '@/features/records/useRecords';

/** The root of every record query (`['records', kind, …]`): lists, pages and their links. */
const RECORDS_ROOT = ['records'] as const;

/** One finding in the queue's list. */
export type FindingRow = GetReviewFindingsResponse['items'][number];
/** One finding in full. */
export type FindingDetail = GetReviewFindingsIdResponse;
export type LinkFindingDetail = Extract<FindingDetail, { kind: 'link' }>;
export type RecordFindingDetail = Extract<FindingDetail, { kind: 'record' }>;
export type DuplicateFindingDetail = Extract<FindingDetail, { kind: 'duplicate' }>;
export type MappingFindingDetail = Extract<FindingDetail, { kind: 'mapping' }>;
/** A link end in full, with its candidates. */
export type LinkEnd = LinkFindingDetail['summary']['from'];
/** A link end as a list row shows it. */
export type LinkEndRow = Extract<FindingRow, { kind: 'link' }>['summary']['from'];
export type Decision = PostReviewFindingsIdApproveResponse | PostReviewFindingsIdRejectResponse;
/** A false positive taken back out: the finding is `removed`, with what the removal did. */
export type Removal = PostReviewFindingsIdRemoveResponse;
/** What removing one upload would touch: the document and its counts. */
export type UploadImpact = GetReviewDocumentsIdResponse;
/** What removing one upload did, as counts only. */
export type UploadRemoval = PostReviewDocumentsIdRemoveResponse;

export const reviewKeys = {
  all: ['review'] as const,
  counts: ['review', 'counts'] as const,
  list: (query: ListQuery) => ['review', 'findings', query] as const,
  one: (id: string) => ['review', 'finding', id] as const,
  documentName: (id: string) => ['review', 'document-name', id] as const,
  documentImpact: (id: string) => ['review', 'document-impact', id] as const,
  recordName: (kind: RecordKind, id: string) => ['review', 'record-name', kind, id] as const,
  documentSearch: (q: string) => ['review', 'document-search', q] as const,
  recordSearch: (kind: RecordKind, q: string) => ['review', 'record-search', kind, q] as const,
};

/** The menu's waiting count asks again this often (and after every decision). */
export const COUNTS_REFRESH_MS = 60_000;

export const REVIEW_PAGE_SIZE = REVIEW_DEFAULT_PAGE_SIZE;

/** The screen's state in the URL. Left out when it is the default: the Links tab, waiting
 * findings, newest first, page 1. `recordKind` only helps the record filter show the record's
 * number and name; the API filters by `recordId` alone. */
export interface ReviewSearch {
  kind?: ReviewFindingKind;
  status?: ReviewFindingStatus;
  documentId?: string;
  recordId?: string;
  recordKind?: RecordKind;
  sort?: 'oldest';
  page?: number;
}

export const DEFAULT_KIND: ReviewFindingKind = 'link';
export const DEFAULT_STATUS: ReviewFindingStatus = 'pending';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the list fail. */
export function validateReviewSearch(raw: Record<string, unknown>): ReviewSearch {
  const out: ReviewSearch = {};
  const kind = oneOf(REVIEW_FINDING_KINDS, raw.kind);
  if (kind && kind !== DEFAULT_KIND) out.kind = kind;
  const status = oneOf(REVIEW_FINDING_STATUSES, raw.status);
  if (status && status !== DEFAULT_STATUS) out.status = status;
  const documentId = uuid(raw.documentId);
  if (documentId) out.documentId = documentId;
  const recordId = uuid(raw.recordId);
  if (recordId) {
    out.recordId = recordId;
    const recordKind = oneOf(RECORD_KINDS, raw.recordKind);
    if (recordKind) out.recordKind = recordKind;
  }
  if (raw.sort === 'oldest') out.sort = 'oldest';
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  return out;
}

/** The list query the API gets for a search: one kind and one status at a time. */
export function reviewQuery(search: ReviewSearch): ListQuery {
  const query: ListQuery = {
    page: search.page ?? 1,
    pageSize: REVIEW_PAGE_SIZE,
    kind: search.kind ?? DEFAULT_KIND,
    status: search.status ?? DEFAULT_STATUS,
    sort: search.sort ?? 'newest',
  };
  if (search.documentId) query.documentId = search.documentId;
  if (search.recordId) query.recordId = search.recordId;
  return query;
}

/** True for the API's "you can't use this screen" answer. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** The pending findings per kind and their total, asked again every minute while it shows. */
export function useReviewCounts(enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.counts,
    queryFn: () => api.getReviewCounts(),
    enabled,
    refetchInterval: COUNTS_REFRESH_MS,
    retry: false,
  });
}

/** One page of one tab's findings. */
export function useReviewList(search: ReviewSearch, enabled: boolean) {
  const query = reviewQuery(search);
  return useQuery({
    queryKey: reviewKeys.list(query),
    queryFn: () => api.getReviewFindings(query),
    placeholderData: keepPreviousData,
    enabled,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

export function useReviewFinding(id: string, enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.one(id),
    queryFn: () => api.getReviewFindingsId({ id }),
    enabled,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/** A document's file name, for the document filter (`null` when the person can't read it). */
export function useDocumentName(documentId: string | undefined) {
  return useQuery({
    queryKey: reviewKeys.documentName(documentId ?? ''),
    queryFn: async (): Promise<string | null> => {
      if (!documentId) return null;
      try {
        const document = await api.getDocumentsId({ id: documentId });
        return document.fileName;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
        throw err;
      }
    },
    enabled: documentId !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const RECORD_GET: Record<RecordKind, (path: { id: string }) => Promise<AnyRecord>> = {
  risk: api.getRisksId,
  control: api.getControlsId,
  policy: api.getPoliciesId,
  asset: api.getAssetsId,
  incident: api.getIncidentsId,
};

const RECORD_SEARCH: Record<RecordKind, (query: ListQuery) => Promise<Paged<AnyRecord>>> = {
  risk: api.getRisks,
  control: api.getControls,
  policy: api.getPolicies,
  asset: api.getAssets,
  incident: api.getIncidents,
};

/** A record's number and name, for the record filter (`null` when the person can't see it). */
export function useRecordName(kind: RecordKind | undefined, id: string | undefined) {
  return useQuery({
    queryKey: reviewKeys.recordName(kind ?? 'risk', id ?? ''),
    queryFn: async (): Promise<{ number: string; name: string } | null> => {
      if (!kind || !id) return null;
      try {
        const record = await RECORD_GET[kind]({ id });
        return { number: record.number, name: record.name };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
        throw err;
      }
    },
    enabled: kind !== undefined && id !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** How many items a filter picker shows for one search. */
export const PICKER_PAGE = 20;

/** Uploaded documents found by file name. Nothing is asked until there's text to search. */
export function useDocumentSearch(q: string) {
  return useQuery({
    queryKey: reviewKeys.documentSearch(q),
    queryFn: () => api.getDocuments({ q, pageSize: PICKER_PAGE }),
    enabled: q !== '',
  });
}

/** One kind's records found by name or number. Nothing is asked until there's text to search. */
export function useRecordSearch(kind: RecordKind, q: string) {
  return useQuery({
    queryKey: reviewKeys.recordSearch(kind, q),
    queryFn: () => RECORD_SEARCH[kind]({ q, pageSize: PICKER_PAGE }),
    enabled: q !== '',
  });
}

/** What one upload put in (S5-004's counts) and the document as the reader sees it. The Admin and
 * the Analyst may ask; `null` when the reader may not see the document (404). */
export function useUploadImpact(documentId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.documentImpact(documentId ?? ''),
    queryFn: async (): Promise<UploadImpact | null> => {
      if (!documentId) return null;
      try {
        return await api.getReviewDocumentsId({ id: documentId });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: enabled && documentId !== undefined,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/**
 * After a decision (or a refusal that means the page is out of date), everything that may show it
 * asks again: the queue, its counts, the finding and the upload counts; every record page and its
 * links (an approved link, a new, merged or retired record); the frameworks screens (an approved or
 * removed mapping); and Data intake (a removed upload).
 */
function useRefreshAfterDecision() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
      queryClient.invalidateQueries({ queryKey: RECORDS_ROOT }),
      queryClient.invalidateQueries({ queryKey: frameworkKeys.all }),
      queryClient.invalidateQueries({ queryKey: intakeKeys.all }),
    ]);
}

/** The refusals that mean the finding on screen is out of date: someone decided it first, it can't
 * be removed any more, or it (or a record it names) is gone or hidden now. */
export function refusalMeansStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 ||
      error.code === 'already_decided' ||
      error.code === 'record_not_active' ||
      error.code === 'not_removable')
  );
}

export function useApproveFinding(id: string) {
  const refresh = useRefreshAfterDecision();
  return useMutation({
    mutationFn: (body: PostReviewFindingsIdApproveBody) => api.postReviewFindingsIdApprove({ id }, body),
    // Not awaited: the page's own callbacks run first (its message and dialog), then the finding,
    // whose buttons go once it is decided, is asked for again.
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => {
      if (refusalMeansStale(error)) void refresh();
    },
  });
}

export function useRejectFinding(id: string) {
  const refresh = useRefreshAfterDecision();
  return useMutation({
    mutationFn: (body: { note?: string }) => api.postReviewFindingsIdReject({ id }, body),
    // Not awaited: the page's own callbacks run first (its message and dialog), then the finding,
    // whose buttons go once it is decided, is asked for again.
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => {
      if (refusalMeansStale(error)) void refresh();
    },
  });
}

/** Removes a live or approved finding that turned out false (D38, D207). */
export function useRemoveFinding(id: string) {
  const refresh = useRefreshAfterDecision();
  return useMutation({
    mutationFn: (body: { note?: string }) => api.postReviewFindingsIdRemove({ id }, body),
    // Not awaited, as for approving: the page's own callbacks run first.
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => {
      if (refusalMeansStale(error)) void refresh();
    },
  });
}

/** Removes everything from one upload in a single action (D52.5). */
export function useRemoveUpload(documentId: string) {
  const refresh = useRefreshAfterDecision();
  return useMutation({
    mutationFn: (body: { note?: string }) => api.postReviewDocumentsIdRemove({ id: documentId }, body),
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) void refresh();
    },
  });
}
