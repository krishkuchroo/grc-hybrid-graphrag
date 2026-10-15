// The Data intake screen's data (S3-011), around the generated typed client (D30): the documents
// list (GET /api/v1/documents), each asset list's import status (GET /api/v1/imports, and for an
// older asset list GET /api/v1/documents/:id then /imports/:id), uploads (POST /api/v1/uploads,
// with progress) and downloads (GET /api/v1/documents/:id/download). Every address is relative
// (the M0-015 rule). The API decides every permission (D7); these hooks fetch, cache and refresh.
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_STATUSES, UPLOAD_KINDS, type DocumentStatus, type ImportStatus, type UploadKind } from '@grc/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type GetDocumentsResponse,
  type ListQuery,
  type PostUploadsBody,
  type PostUploadsResponse,
  type UploadProgress,
} from '@/api/client';

/** A stored document as the list returns it. */
export type DocumentItem = GetDocumentsResponse['items'][number];

/** An asset list's latest import: `null` when it has none yet, `undefined` while it's being found. */
export interface ImportSummary {
  id: string;
  status: ImportStatus;
}

export interface DocumentRow {
  document: DocumentItem;
  import: ImportSummary | null | undefined;
}

export const intakeKeys = {
  all: ['intake'] as const,
  documents: (query: ListQuery) => ['intake', 'documents', query] as const,
  recentImports: ['intake', 'imports', 'recent'] as const,
  documentImport: (documentId: string) => ['intake', 'document-import', documentId] as const,
};

/** How often the table asks again while anything on it is still working. */
export const REFRESH_MS = 5_000;

/** The import statuses that move on by themselves; `needs_mapping` waits for a person. */
const IMPORT_WORKING: ReadonlySet<ImportStatus> = new Set(['reading', 'queued', 'importing']);
/** A document stored but not yet processed is queued for processing (S4), so it's still working. */
const DOCUMENT_WORKING: ReadonlySet<DocumentStatus> = new Set(['stored', 'processing']);

/** Whether a row will change by itself: an asset list by its import, any other kind by its status. */
export function isWorking(row: DocumentRow): boolean {
  if (row.document.kind === 'asset_list') {
    return row.import ? IMPORT_WORKING.has(row.import.status) : row.import === undefined;
  }
  return DOCUMENT_WORKING.has(row.document.status);
}

/** The table's state in the URL: page, sort and filters, under the API's own names (D47). */
export interface IntakeSearch {
  page?: number;
  sort?: string;
  kind?: UploadKind;
  status?: DocumentStatus;
  q?: string;
}

export const DOCUMENT_SORTS = ['createdAt', 'fileName'] as const;
export const DEFAULT_SORT = '-createdAt';
export const PAGE_SIZE = 25;

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the list fail. */
export function validateIntakeSearch(raw: Record<string, unknown>): IntakeSearch {
  const out: IntakeSearch = {};
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  const sort = text(raw.sort);
  if (sort && (DOCUMENT_SORTS as readonly string[]).includes(sort.replace(/^-/, ''))) out.sort = sort;
  const kind = text(raw.kind);
  if (kind && (UPLOAD_KINDS as readonly string[]).includes(kind)) out.kind = kind as UploadKind;
  const status = text(raw.status);
  if (status && (DOCUMENT_STATUSES as readonly string[]).includes(status)) out.status = status as DocumentStatus;
  const q = text(raw.q);
  if (q) out.q = q.slice(0, 200);
  return out;
}

/** The list query the API gets for a search. */
export function documentQuery(search: IntakeSearch): ListQuery {
  const query: ListQuery = { page: search.page ?? 1, pageSize: PAGE_SIZE };
  if (search.sort) query.sort = search.sort;
  if (search.kind) query.kind = search.kind;
  if (search.status) query.status = search.status;
  if (search.q) query.q = search.q;
  return query;
}

/**
 * One page of documents, each asset list with its latest import, refreshed every 5 s while any row
 * is still working and not at all once none is.
 */
export function useDocumentRows(search: IntakeSearch) {
  const query = useMemo(() => documentQuery(search), [search]);
  const [working, setWorking] = useState(false);
  const interval = working ? REFRESH_MS : false;

  const documents = useQuery({
    queryKey: intakeKeys.documents(query),
    queryFn: () => api.getDocuments(query),
    placeholderData: keepPreviousData,
    refetchInterval: interval,
  });

  const items = documents.data?.items;
  const assetListIds = useMemo(() => (items ?? []).filter((d) => d.kind === 'asset_list').map((d) => d.id), [items]);

  // The newest imports, newest first, so the first one seen for a document is its latest.
  const recent = useQuery({
    queryKey: intakeKeys.recentImports,
    queryFn: () => api.getImports({ page: 1, pageSize: 100 }),
    enabled: assetListIds.length > 0,
    refetchInterval: interval,
    retry: false,
  });
  const latestByDocument = useMemo(() => {
    const map = new Map<string, ImportSummary>();
    for (const imp of recent.data?.items ?? []) {
      if (!map.has(imp.documentId)) map.set(imp.documentId, { id: imp.id, status: imp.status });
    }
    return map;
  }, [recent.data]);

  // An older asset list whose import isn't among the newest: found through the document itself.
  const missing = recent.isFetched ? assetListIds.filter((id) => !latestByDocument.has(id)) : [];
  const older = useQueries({
    queries: missing.map((documentId) => ({
      queryKey: intakeKeys.documentImport(documentId),
      queryFn: async (): Promise<ImportSummary | null> => {
        const document = await api.getDocumentsId({ id: documentId });
        const importId = typeof document.importId === 'string' ? document.importId : null;
        if (importId === null) return null;
        const found = await api.getImportsId({ id: importId });
        return { id: found.id, status: found.status };
      },
      refetchInterval: interval,
      retry: false,
    })),
  });

  const olderById = new Map(missing.map((id, i) => [id, older[i]] as const));
  const rows: DocumentRow[] = (items ?? []).map((document) => {
    if (document.kind !== 'asset_list') return { document, import: null };
    const latest = latestByDocument.get(document.id);
    if (latest) return { document, import: latest };
    const found = olderById.get(document.id);
    // Not findable (the imports list or the document refused): shown with its document status.
    if (found?.isError || (recent.isError && !found)) return { document, import: null };
    return { document, import: found?.data };
  });

  const nowWorking = rows.some(isWorking);
  useEffect(() => setWorking(nowWorking), [nowWorking]);

  return { documents, rows, working: nowWorking };
}

/** True for the API's "you can't use this screen" answer. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export interface UploadInput {
  body: PostUploadsBody;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** Uploads one file; afterwards the documents table asks the API again. */
export function useUpload() {
  const queryClient = useQueryClient();
  return useMutation<PostUploadsResponse, unknown, UploadInput>({
    mutationFn: ({ body, onProgress, signal }) =>
      api.postUploads(body, {
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intakeKeys.all }),
  });
}

/** An asset list's latest import, for the repeat-upload notice's link. */
export function useDocumentImport(documentId: string | undefined) {
  return useQuery({
    queryKey: ['intake', 'document', documentId ?? ''] as const,
    queryFn: async (): Promise<string | null> => {
      if (documentId === undefined) return null;
      const document = await api.getDocumentsId({ id: documentId });
      return typeof document.importId === 'string' ? document.importId : null;
    },
    enabled: documentId !== undefined,
    retry: false,
  });
}

/** Hands a downloaded file to the browser to save under its name. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser has started the download by now; the bytes are let go a little later.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Downloads one document through the API (audited there as document.downloaded) and saves it. */
export function useDownload() {
  return useMutation<void, unknown, DocumentItem>({
    mutationFn: async (document) => {
      const file = await api.getDocumentsIdDownload({ id: document.id });
      saveFile(file.blob, file.fileName ?? document.fileName);
    },
  });
}
