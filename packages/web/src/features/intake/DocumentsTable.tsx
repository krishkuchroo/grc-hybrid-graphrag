// The uploaded documents (S3-011, D27 #10), in the ServiceNow list style (D2): a file-name search
// and kind and status filters over a dense table, paged and sorted by the API (D47), with the
// state in the URL under the API's own names. Each row downloads its file through the API, and an
// asset list's file name opens its import (`/intake/imports/$id`). While any row is still working,
// the list asks again every 5 s (useDocumentRows).
import { useRouter } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { DOCUMENT_STATUSES, type UploadKind } from '@grc/shared';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatDay } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { usePeople } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { FORMAT_TEXT, formatBytes, KIND_TEXT } from './permissions';
import { documentStatusText, StatusBadge } from './StatusBadge';
import {
  DEFAULT_SORT,
  PAGE_SIZE,
  REFRESH_MS,
  useDownload,
  type DocumentItem,
  type DocumentRow,
  type IntakeSearch,
} from './useDocuments';

const TIME = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' });

/** The time of day of a moment, `10:05 AM`. */
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : TIME.format(date);
}

/** The address of an asset list's import page. */
export function importHref(importId: string): string {
  return `/intake/imports/${encodeURIComponent(importId)}`;
}

/** A link inside the app to an address the router resolves (a new tab or window works as usual). */
export function AppLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const router = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void router.navigate({ href });
  };
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

interface CellContext {
  row: DocumentRow;
  uploaderName: string;
}

interface Column {
  id: string;
  header: string;
  sortKey?: 'fileName' | 'createdAt';
  firstSort?: 'asc' | 'desc';
  numeric?: boolean;
  cell: (ctx: CellContext) => ReactNode;
}

function FileCell({ row }: { row: DocumentRow }) {
  const { document } = row;
  const Icon = document.kind === 'asset_list' ? FileSpreadsheet : FileText;
  const source = typeof document.source === 'string' ? document.source : null;
  const name =
    document.kind === 'asset_list' && row.import ? (
      <AppLink
        href={importHref(row.import.id)}
        className="text-primary font-semibold [overflow-wrap:anywhere] hover:underline focus-visible:underline"
      >
        {document.fileName}
      </AppLink>
    ) : (
      <span className="font-semibold [overflow-wrap:anywhere]">{document.fileName}</span>
    );
  return (
    <div className="flex min-w-[14rem] max-w-[20rem] items-start gap-2">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {name}
        {source ? <p className="text-muted-foreground text-xs">From {source}</p> : null}
      </div>
    </div>
  );
}

function DownloadButton({ document, onError }: { document: DocumentItem; onError: (err: unknown) => void }) {
  const download = useDownload();
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="size-8"
      aria-label={`Download ${document.fileName}`}
      title={`Download ${document.fileName}`}
      disabled={download.isPending}
      onClick={() => download.mutate(document, { onError })}
    >
      {download.isPending ? <LoaderCircle className="animate-spin" aria-hidden /> : <Download aria-hidden />}
    </Button>
  );
}

function SortIcon({ state }: { state: 'ascending' | 'descending' | 'none' }) {
  if (state === 'ascending') return <ArrowUp className="size-3.5" aria-hidden />;
  if (state === 'descending') return <ArrowDown className="size-3.5" aria-hidden />;
  return <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />;
}

const features = tableFeatures({});
const NO_ROWS: DocumentRow[] = [];

/** The words for a download that failed. */
function downloadProblem(err: unknown): { title: string; error: unknown } {
  if (err instanceof ApiError && err.status === 404) {
    return {
      title: 'The file couldn’t be downloaded',
      error: new ApiError(404, err.code, 'This document doesn’t exist or you can’t see it.', err.referenceId),
    };
  }
  if (err instanceof ApiError && err.status === 403) {
    return {
      title: 'The file couldn’t be downloaded',
      error: new ApiError(403, err.code, 'You don’t have permission to download this file.', err.referenceId),
    };
  }
  return { title: 'The file couldn’t be downloaded', error: err };
}

export interface DocumentsTableProps {
  rows: DocumentRow[];
  /** The documents query's state. */
  isPending: boolean;
  isPlaceholderData: boolean;
  error: unknown;
  total: number | undefined;
  /** Some row is still working, so the list asks again every 5 s. */
  working: boolean;
  search: IntakeSearch;
  onSearchChange: (next: IntakeSearch) => void;
  /** The kinds in the kind filter. */
  kinds: readonly UploadKind[];
  /** A document to pick out (the one just uploaded, or the one a repeat upload matched). */
  highlightId?: string | undefined;
  /** What an empty list says when nothing has been uploaded. */
  emptyText: string;
}

export function DocumentsTable({
  rows,
  isPending,
  isPlaceholderData,
  error,
  total,
  working,
  search,
  onSearchChange,
  kinds,
  highlightId,
  emptyText,
}: DocumentsTableProps) {
  const page = search.page ?? 1;
  const sort = search.sort ?? DEFAULT_SORT;
  const filtered = search.kind !== undefined || search.status !== undefined || search.q !== undefined;
  const people = usePeople();
  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p.name])), [people.data]);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  /** A change to one filter goes back to page 1. */
  const setFilter = (key: 'kind' | 'status' | 'q', value: string) => {
    const next: IntakeSearch = { ...search };
    delete next.page;
    if (value === '') delete next[key];
    else (next as Record<string, unknown>)[key] = value;
    onSearchChange(next);
  };

  // The search box: typed text reaches the URL (and the API) after a short pause.
  const urlQ = search.q ?? '';
  const [typed, setTyped] = useState(urlQ);
  const pushed = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== pushed.current) {
      pushed.current = urlQ;
      setTyped(urlQ);
    }
  }, [urlQ]);
  const latestSetFilter = useRef(setFilter);
  latestSetFilter.current = setFilter;
  useEffect(() => {
    const wanted = typed.trim();
    if (wanted === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = wanted;
      latestSetFilter.current('q', wanted);
    }, 250);
    return () => clearTimeout(timer);
  }, [typed]);

  const columns: Column[] = useMemo(
    () => [
      {
        id: 'fileName',
        header: 'File name',
        sortKey: 'fileName',
        firstSort: 'asc',
        cell: ({ row }) => <FileCell row={row} />,
      },
      {
        id: 'kind',
        header: 'Kind',
        cell: ({ row }) => <span className="whitespace-nowrap">{KIND_TEXT[row.document.kind]}</span>,
      },
      {
        id: 'format',
        header: 'Format',
        cell: ({ row }) => <span className="font-mono text-xs">{FORMAT_TEXT[row.document.format]}</span>,
      },
      {
        id: 'size',
        header: 'Size',
        numeric: true,
        cell: ({ row }) => <span className="whitespace-nowrap">{formatBytes(row.document.sizeBytes)}</span>,
      },
      { id: 'label', header: 'Label', cell: ({ row }) => <LabelBadge label={row.document.label} /> },
      {
        id: 'uploader',
        header: 'Uploaded by',
        cell: ({ uploaderName: name }) => <span className="whitespace-nowrap">{name}</span>,
      },
      {
        id: 'createdAt',
        header: 'Uploaded',
        sortKey: 'createdAt',
        firstSort: 'desc',
        cell: ({ row }) => (
          <span className="grid whitespace-nowrap">
            <span>{formatDay(row.document.createdAt)}</span>
            <span className="text-muted-foreground text-xs">{formatTime(row.document.createdAt)}</span>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) =>
          row.document.kind === 'asset_list' && row.import ? (
            <StatusBadge importStatus={row.import.status} />
          ) : (
            <StatusBadge documentStatus={row.document.status} />
          ),
      },
      {
        id: 'download',
        header: 'Download',
        cell: ({ row }) => <DownloadButton document={row.document} onError={setDownloadError} />,
      },
    ],
    [],
  );

  const peoplePending = people.isPending;
  const tableColumns = useMemo(() => {
    const uploaderName = (document: DocumentItem): string => {
      if (document.uploader.type === 'api_key') return 'API key';
      if (document.uploader.type === 'system') return 'System';
      return names.get(document.uploader.id) ?? (peoplePending ? '…' : 'Former member');
    };
    const helper = createColumnHelper<typeof features, DocumentRow>();
    return columns.map((col) =>
      helper.display({
        id: col.id,
        header: col.header,
        cell: (info) => col.cell({ row: info.row.original, uploaderName: uploaderName(info.row.original.document) }),
      }),
    );
  }, [columns, names, peoplePending]);
  const table = useTable({ features, columns: tableColumns, data: rows.length > 0 ? rows : NO_ROWS });

  const sortState = (col: Column): 'ascending' | 'descending' | 'none' => {
    if (!col.sortKey) return 'none';
    if (sort.replace(/^-/, '') !== col.sortKey) return 'none';
    return sort.startsWith('-') ? 'descending' : 'ascending';
  };
  const toggleSort = (col: Column) => {
    if (!col.sortKey) return;
    const state = sortState(col);
    let next: string;
    if (state === 'none') next = col.firstSort === 'desc' ? `-${col.sortKey}` : col.sortKey;
    else next = state === 'ascending' ? `-${col.sortKey}` : col.sortKey;
    const out: IntakeSearch = { ...search, sort: next };
    if (next === DEFAULT_SORT) delete out.sort;
    delete out.page;
    onSearchChange(out);
  };
  const goTo = (n: number) => {
    const out: IntakeSearch = { ...search, page: n };
    if (n <= 1) delete out.page;
    onSearchChange(out);
  };

  const count = total ?? 0;
  const first = count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, count);
  const tableRows = table.getRowModel().rows;

  let body: ReactNode;
  if (error && total === undefined) {
    body = (
      <div className="p-6">
        <ApiProblem error={error} title="The documents couldn't be shown" />
      </div>
    );
  } else if (isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading documents…</span>
      </div>
    );
  } else if (tableRows.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="max-w-md text-sm">{filtered ? 'No documents match these filters.' : emptyText}</p>
        {filtered ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onSearchChange({})}>
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader className="bg-muted/70">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header, i) => {
                const col = columns[i]!;
                const state = sortState(col);
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={col.sortKey ? state : undefined}
                    className={cn(col.numeric && 'text-right')}
                  >
                    {col.id === 'download' ? (
                      <span className="sr-only">{col.header}</span>
                    ) : col.sortKey ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col)}
                        className={cn(
                          'hover:text-primary focus-visible:ring-ring/50 -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-[3px]',
                          state !== 'none' && 'text-primary',
                        )}
                      >
                        {col.header}
                        <SortIcon state={state} />
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody className={cn(isPlaceholderData && 'opacity-60')}>
          {tableRows.map((row) => {
            const picked = row.original.document.id === highlightId;
            return (
              <TableRow
                key={row.original.document.id}
                data-highlighted={picked ? 'true' : undefined}
                className={cn(
                  'even:bg-muted/30 hover:bg-accent/60',
                  picked && 'bg-accent even:bg-accent shadow-[inset_3px_0_0_var(--color-primary)]',
                )}
              >
                {row.getAllCells().map((cell, i) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      columns[i]!.numeric && 'text-right tabular-nums',
                      columns[i]!.id === 'download' && 'text-right',
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-label="Uploaded documents" className="bg-card rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="mr-2 text-sm font-semibold">Uploaded documents</h2>
        <div className="relative w-full sm:w-64">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search file name"
            placeholder="Search file name"
            className="pl-8"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Kind"
          className="w-40"
          value={search.kind ?? ''}
          onChange={(e) => setFilter('kind', e.target.value)}
        >
          <option value="">Any kind</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_TEXT[kind]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          className="w-36"
          value={search.status ?? ''}
          onChange={(e) => setFilter('status', e.target.value)}
        >
          <option value="">Any status</option>
          {DOCUMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {documentStatusText(status)}
            </option>
          ))}
        </NativeSelect>
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSearchChange({})}>
            <X aria-hidden />
            Clear
          </Button>
        ) : null}
        {working ? (
          <p className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs" role="status">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Checking for updates every {REFRESH_MS / 1000} s
          </p>
        ) : null}
      </div>

      {downloadError ? (
        <div className="border-b p-4">
          <ApiProblem {...downloadProblem(downloadError)}>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => setDownloadError(null)}>
              Dismiss
            </Button>
          </ApiProblem>
        </div>
      ) : null}

      {body}

      {total !== undefined && count > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
          <p>
            <span className="text-foreground font-semibold tabular-nums">
              {first}–{last}
            </span>{' '}
            of <span className="text-foreground font-semibold tabular-nums">{count}</span> documents
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={last >= count} onClick={() => goTo(page + 1)}>
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
