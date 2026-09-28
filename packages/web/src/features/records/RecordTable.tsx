// A record list in the ServiceNow style (D2): a search box and filters over a dense table, paged,
// sorted and filtered by the API (D47). The filters live in the URL search params under the API's
// own names, so a reload asks the API the same question. TanStack Table renders the rows; the
// server has already paged, sorted and filtered them.
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { LABELS, type RecordKind } from '@grc/shared';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ListQuery } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/api/client';
import { cn } from '@/lib/utils';
import { ApiProblem } from './ApiProblem';
import { formatDay, words } from './format';
import { LabelBadge } from './LabelBadge';
import { OwnerPicker } from './OwnerPicker';
import { useRecordList, usePeople, type AnyRecord } from './useRecords';

/** The list's state in the URL: page, sort and filters, under the API's own names. */
export type ListSearch = Partial<Record<string, string | number>>;

export interface FilterDef {
  /** The API's parameter name, also the URL's. */
  key: string;
  /** The filter's accessible name, for example "Band". */
  label: string;
  /** The empty choice's text, for example "Any band". */
  anyText: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export interface CellContext<R> {
  record: R;
  ownerName: string;
}

export interface ColumnDef<R> {
  id: string;
  header: string;
  /** The API's sort field, when the column sorts. */
  sortKey?: string;
  /** Which way the first click sorts. */
  firstSort?: 'asc' | 'desc';
  numeric?: boolean;
  cell: (ctx: CellContext<R>) => ReactNode;
}

const STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All' },
] as const;

const COMMON_KEYS = ['q', 'owner', 'label', 'status'] as const;

export const PAGE_SIZE = 25;

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the list fail. */
export function validateListSearch(
  raw: Record<string, unknown>,
  opts: { filters: readonly FilterDef[]; sorts: readonly string[] },
): ListSearch {
  const out: ListSearch = {};
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  const sort = text(raw.sort);
  if (sort && opts.sorts.includes(sort.replace(/^-/, ''))) out.sort = sort;
  const q = text(raw.q);
  if (q) out.q = q;
  const owner = text(raw.owner);
  if (owner) out.owner = owner;
  const label = text(raw.label);
  if (label && (LABELS as readonly string[]).includes(label)) out.label = label;
  const status = text(raw.status);
  if (status === 'retired' || status === 'all') out.status = status;
  for (const filter of opts.filters) {
    const value = text(raw[filter.key]);
    if (value && filter.options.some((o) => o.value === value)) out[filter.key] = value;
  }
  return out;
}

// ---- Columns every record list shares ---------------------------------------------------------

export function numberColumn<R extends AnyRecord>(link: (record: R) => ReactNode): ColumnDef<R> {
  return { id: 'number', header: 'Number', sortKey: 'number', cell: ({ record }) => link(record) };
}

export function nameColumn<R extends AnyRecord>(): ColumnDef<R> {
  return {
    id: 'name',
    header: 'Name',
    sortKey: 'name',
    cell: ({ record }) => <span className="line-clamp-2 min-w-[14rem]">{record.name}</span>,
  };
}

export function ownerColumn<R extends AnyRecord>(): ColumnDef<R> {
  return {
    id: 'owner',
    header: 'Owner',
    cell: ({ ownerName }) => <span className="whitespace-nowrap">{ownerName}</span>,
  };
}

export function labelColumn<R extends AnyRecord>(): ColumnDef<R> {
  return { id: 'label', header: 'Label', cell: ({ record }) => <LabelBadge label={record.label} /> };
}

export function updatedColumn<R extends AnyRecord>(): ColumnDef<R> {
  return {
    id: 'updated',
    header: 'Updated',
    sortKey: 'updatedAt',
    firstSort: 'desc',
    cell: ({ record }) => (
      <span className="text-muted-foreground whitespace-nowrap">{formatDay(record.updatedAt)}</span>
    ),
  };
}

// ---- The table ------------------------------------------------------------------------------

const features = tableFeatures({});
const NO_ROWS: AnyRecord[] = [];

interface Props<R extends AnyRecord> {
  kind: RecordKind;
  /** Plural, lowercase: "risks". */
  noun: string;
  columns: ColumnDef<R>[];
  filters: readonly FilterDef[];
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
  /** What the list says when the kind has no records at all. */
  emptyText: string;
}

function SortIcon({ state }: { state: 'ascending' | 'descending' | 'none' }) {
  if (state === 'ascending') return <ArrowUp className="size-3.5" aria-hidden />;
  if (state === 'descending') return <ArrowDown className="size-3.5" aria-hidden />;
  return <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />;
}

export function RecordTable<R extends AnyRecord>({
  kind,
  noun,
  columns,
  filters,
  search,
  onSearchChange,
  emptyText,
}: Props<R>) {
  const page = typeof search.page === 'number' ? search.page : 1;
  const sort = typeof search.sort === 'string' ? search.sort : undefined;
  const filterKeys = useMemo(() => [...COMMON_KEYS, ...filters.map((f) => f.key)], [filters]);
  const filtered = filterKeys.some((key) => search[key] !== undefined && key !== 'status');

  const query: ListQuery = useMemo(() => {
    const q: ListQuery = { page, pageSize: PAGE_SIZE };
    if (sort) q.sort = sort;
    for (const key of filterKeys) if (search[key] !== undefined) q[key] = search[key];
    return q;
  }, [page, sort, filterKeys, search]);

  const list = useRecordList(kind, query);
  const people = usePeople();
  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p.name])), [people.data]);

  /** A change to one filter goes back to page 1. */
  const setFilter = (key: string, value: string) => {
    const next: ListSearch = { ...search, [key]: value === '' ? undefined : value };
    delete next.page;
    if (value === '') delete next[key];
    onSearchChange(next);
  };

  // The search box: typed text reaches the URL (and the API) after a short pause.
  const urlQ = typeof search.q === 'string' ? search.q : '';
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

  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, R>();
    return columns.map((col) =>
      helper.display({
        id: col.id,
        header: col.header,
        cell: (info) => col.cell({ record: info.row.original, ownerName: names.get(info.row.original.owner) ?? '—' }),
      }),
    );
  }, [columns, names]);
  const table = useTable({ features, columns: tableColumns, data: (list.data?.items ?? NO_ROWS) as R[] });

  const sortState = (col: ColumnDef<R>): 'ascending' | 'descending' | 'none' => {
    if (!col.sortKey) return 'none';
    const current = sort ?? 'number';
    if (current.replace(/^-/, '') !== col.sortKey) return 'none';
    return current.startsWith('-') ? 'descending' : 'ascending';
  };
  const toggleSort = (col: ColumnDef<R>) => {
    if (!col.sortKey) return;
    const state = sortState(col);
    let next: string;
    if (state === 'none') next = col.firstSort === 'desc' ? `-${col.sortKey}` : col.sortKey;
    else next = state === 'ascending' ? `-${col.sortKey}` : col.sortKey;
    const out: ListSearch = { ...search, sort: next };
    delete out.page;
    onSearchChange(out);
  };
  const goTo = (n: number) => {
    const out: ListSearch = { ...search, page: n };
    if (n <= 1) delete out.page;
    onSearchChange(out);
  };

  const loading = list.isPending || people.isPending;
  const total = list.data?.total ?? 0;
  const rows = table.getRowModel().rows;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);

  let body: ReactNode;
  if (list.isError && !list.data) {
    body = (
      <div className="p-6">
        <ApiProblem
          error={list.error}
          title={
            list.error instanceof ApiError && list.error.status === 403
              ? 'No access to this list'
              : `The ${noun} couldn't be shown`
          }
        />
      </div>
    );
  } else if (loading) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading {noun}…</span>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="max-w-md text-sm">{filtered ? `No ${noun} match these filters.` : emptyText}</p>
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
                    {col.sortKey ? (
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
        <TableBody className={cn(list.isPlaceholderData && 'opacity-60')}>
          {rows.map((row) => (
            <TableRow key={row.id} className="even:bg-muted/30 hover:bg-accent/60">
              {row.getAllCells().map((cell, i) => (
                <TableCell key={cell.id} className={cn(columns[i]!.numeric && 'text-right tabular-nums')}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-label={`${words(noun)} list`} className="bg-card rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="relative w-full sm:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search"
            placeholder="Search name or number"
            className="pl-8"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {filters.map((filter) => (
          <NativeSelect
            key={filter.key}
            aria-label={filter.label}
            className="w-36"
            value={typeof search[filter.key] === 'string' ? (search[filter.key] as string) : ''}
            onChange={(e) => setFilter(filter.key, e.target.value)}
          >
            <option value="">{filter.anyText}</option>
            {filter.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        ))}
        <OwnerPicker
          aria-label="Owner"
          className="w-44"
          allowEmpty
          emptyText="Any owner"
          value={typeof search.owner === 'string' ? search.owner : ''}
          onValueChange={(value) => setFilter('owner', value)}
        />
        <NativeSelect
          aria-label="Label"
          className="w-36"
          value={typeof search.label === 'string' ? search.label : ''}
          onChange={(e) => setFilter('label', e.target.value)}
        >
          <option value="">Any label</option>
          {LABELS.map((label) => (
            <option key={label} value={label}>
              {words(label)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          className="w-32"
          value={typeof search.status === 'string' ? search.status : 'active'}
          onChange={(e) => setFilter('status', e.target.value === 'active' ? '' : e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSearchChange({})}>
            <X aria-hidden />
            Clear
          </Button>
        ) : null}
      </div>

      {body}

      {list.data && total > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
          <p>
            <span className="text-foreground font-semibold tabular-nums">
              {first}–{last}
            </span>{' '}
            of <span className="text-foreground font-semibold tabular-nums">{total}</span> {noun}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={last >= total} onClick={() => goTo(page + 1)}>
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
