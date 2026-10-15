// One framework (D27, screen 7): its version, publisher and coverage for the signed-in person, and
// its requirements in a ServiceNow-style list (D2): natural code order, paged, filtered by group,
// coverage and status, and searched on code or title, all by the API (D47). The filters live in the
// URL search params under the API's own names, so a reload or a shared link asks the same question.
// Coverage comes only from the API's SATISFIES counts (D212 (5)); a hidden control neither shows
// nor counts (D51). Catalogs are read-only here.
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FRAMEWORKS } from '@grc/shared';
import type { ListQuery } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem, NOT_FOUND_TEXT } from '@/features/records/ApiProblem';
import { RecordNotFound, StatusBadge } from '@/features/records/RecordPage';
import { PAGE_SIZE } from '@/features/records/RecordTable';
import { isNotFound } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import {
  CoverageBar,
  CoverageLegend,
  CoverageState,
  coveredPercent,
  coverageSentence,
  formatCount,
  type Coverage,
} from './CoverageBar';
import {
  groupChoices,
  groupLabel,
  useFramework,
  useRequirementList,
  type FrameworkSummary,
  type RequirementRow,
} from './useFrameworks';

// ---- The page's state in the URL -------------------------------------------------------------

export const COVERAGE_FILTERS = [
  { value: 'covered', label: 'Covered' },
  { value: 'implemented', label: 'Implemented' },
  { value: 'not_covered', label: 'Not covered' },
] as const;

export const STATUS_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All' },
] as const;

export type CoverageFilter = (typeof COVERAGE_FILTERS)[number]['value'];

/** The requirements table's state in the URL, under the API's own names. Defaults are left out. */
export interface RequirementSearch {
  page?: number;
  /** Natural code order is the default; `-code` reverses it. */
  sort?: '-code';
  /** Active requirements are the default; retired ones show only when asked for. */
  status?: 'retired' | 'all';
  coverage?: CoverageFilter;
  /** A group code: `AC`, `GV.OC`, `A.5`, `CC6`. */
  group?: string;
  /** A search on code or title. */
  q?: string;
}

/** Every group code of every framework: the only values the API's `group` filter takes. */
const GROUP_CODES: ReadonlySet<string> = new Set(
  Object.values(FRAMEWORKS).flatMap((framework) => Object.keys(framework.groupNames)),
);

/** The longest search the API takes. */
const MAX_SEARCH = 200;

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the list fail. */
export function validateRequirementSearch(raw: Record<string, unknown>): RequirementSearch {
  const out: RequirementSearch = {};
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  if (text(raw.sort) === '-code') out.sort = '-code';
  const status = text(raw.status);
  if (status === 'retired' || status === 'all') out.status = status;
  const coverage = text(raw.coverage);
  const known = COVERAGE_FILTERS.find((c) => c.value === coverage);
  if (known) out.coverage = known.value;
  const group = text(raw.group);
  if (group && GROUP_CODES.has(group)) out.group = group;
  const q = text(raw.q);
  if (q) out.q = q.slice(0, MAX_SEARCH).trim();
  return out;
}

// ---- Pieces -------------------------------------------------------------------------------

function BackToFrameworks() {
  return (
    <Link to="/frameworks" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Frameworks
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function coverageOf(framework: FrameworkSummary): Coverage {
  return {
    total: framework.requirementCount,
    covered: framework.coveredCount,
    implemented: framework.implementedCount,
  };
}

function FrameworkHeader({ framework }: { framework: FrameworkSummary }) {
  const coverage = coverageOf(framework);
  return (
    <div className="bg-card border-b px-8 pt-4 pb-6">
      <div className="text-muted-foreground mb-2 text-xs">
        <BackToFrameworks />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="grid min-w-0 gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{framework.name}</h1>
          <p className="text-muted-foreground max-w-[70ch] text-sm">{framework.description}</p>
          <dl className="mt-2 flex flex-wrap gap-x-10 gap-y-3">
            <Fact label="Version">{framework.frameworkVersion}</Fact>
            <Fact label="Publisher">{framework.publisher}</Fact>
            <Fact label="Number">
              <span className="tabular-nums">{framework.number}</span>
            </Fact>
            <Fact label="Requirements">
              <span className="tabular-nums">{formatCount(framework.requirementCount)}</span>
            </Fact>
          </dl>
        </div>
        <section aria-label="Coverage" className="bg-background/70 grid gap-2.5 rounded-lg border px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-muted-foreground text-xs font-semibold">Coverage</h2>
            <span className="text-2xl leading-none font-bold tabular-nums">{coveredPercent(coverage)}%</span>
          </div>
          <CoverageBar coverage={coverage} size="lg" />
          <p className="text-sm font-semibold">{coverageSentence(coverage)}</p>
          <CoverageLegend coverage={coverage} />
        </section>
      </div>
    </div>
  );
}

/** What is typed reaches the URL (and the API) after a short pause. */
function useDebouncedSearch(urlValue: string, onCommit: (value: string) => void) {
  const [typed, setTyped] = useState(urlValue);
  const pushed = useRef(urlValue);
  useEffect(() => {
    if (urlValue !== pushed.current) {
      pushed.current = urlValue;
      setTyped(urlValue);
    }
  }, [urlValue]);
  const latestCommit = useRef(onCommit);
  latestCommit.current = onCommit;
  useEffect(() => {
    const wanted = typed.trim();
    if (wanted === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = wanted;
      latestCommit.current(wanted);
    }, 250);
    return () => clearTimeout(timer);
  }, [typed]);
  return [typed, setTyped] as const;
}

// ---- The requirements table ------------------------------------------------------------------

const features = tableFeatures({});
const NO_ROWS: RequirementRow[] = [];

interface Column {
  id: string;
  header: string;
  numeric?: boolean;
  /** Only the code sorts (natural code order, or reversed). */
  sorts?: boolean;
  cell: (row: RequirementRow) => ReactNode;
}

function RequirementsTable({
  framework,
  search,
  onSearchChange,
}: {
  framework: FrameworkSummary;
  search: RequirementSearch;
  onSearchChange: (next: RequirementSearch) => void;
}) {
  const groups = useMemo(() => groupChoices(framework.key), [framework.key]);
  // A group from another framework's list asks nothing: the filter shows "Any group".
  const group = search.group !== undefined && groups.some((g) => g.value === search.group) ? search.group : undefined;
  const page = search.page ?? 1;

  const query: ListQuery = useMemo(() => {
    const q: ListQuery = { page, pageSize: PAGE_SIZE };
    if (search.sort) q.sort = search.sort;
    if (search.status) q.status = search.status;
    if (search.coverage) q.coverage = search.coverage;
    if (group) q.group = group;
    if (search.q) q.q = search.q;
    return q;
  }, [page, search.sort, search.status, search.coverage, group, search.q]);

  const list = useRequirementList(framework.id, query);

  const filtered =
    search.q !== undefined || group !== undefined || search.coverage !== undefined || search.status !== undefined;

  /** A change to one filter goes back to page 1. */
  const setFilter = (key: 'q' | 'group' | 'coverage' | 'status', value: string) => {
    const next: Record<string, unknown> = { ...search, [key]: value === '' ? undefined : value };
    delete next.page;
    if (value === '') delete next[key];
    onSearchChange(next as RequirementSearch);
  };

  const [typed, setTyped] = useDebouncedSearch(search.q ?? '', (value) => setFilter('q', value));

  const sortState: 'ascending' | 'descending' = search.sort === '-code' ? 'descending' : 'ascending';
  const toggleSort = () => {
    const next: RequirementSearch = { ...search };
    delete next.page;
    if (sortState === 'ascending') next.sort = '-code';
    else delete next.sort;
    onSearchChange(next);
  };
  const goTo = (n: number) => {
    const next: RequirementSearch = { ...search, page: n };
    if (n <= 1) delete next.page;
    onSearchChange(next);
  };

  const columns: Column[] = useMemo(
    () => [
      {
        id: 'code',
        header: 'Code',
        sorts: true,
        cell: (row) => (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <Link
              to="/requirements/$id"
              params={{ id: row.id }}
              className="text-primary font-semibold tabular-nums hover:underline"
            >
              {row.code}
            </Link>
            {row.status === 'retired' ? <StatusBadge status="retired" /> : null}
          </span>
        ),
      },
      {
        id: 'title',
        header: 'Title',
        cell: (row) => <span className="line-clamp-2 min-w-[16rem]">{row.title}</span>,
      },
      {
        id: 'group',
        header: 'Group',
        cell: (row) => <span className="line-clamp-2 min-w-[10rem]">{groupLabel(row.framework, row.group)}</span>,
      },
      {
        id: 'coverage',
        header: 'Coverage',
        cell: (row) => <CoverageState covered={row.covered} implemented={row.implemented} />,
      },
      {
        id: 'controls',
        header: 'Controls',
        numeric: true,
        cell: (row) => formatCount(row.controlCount),
      },
    ],
    [],
  );

  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, RequirementRow>();
    return columns.map((col) =>
      helper.display({ id: col.id, header: col.header, cell: (info) => col.cell(info.row.original) }),
    );
  }, [columns]);
  const table = useTable({ features, columns: tableColumns, data: list.data?.items ?? NO_ROWS });

  const total = list.data?.total ?? 0;
  const rows = table.getRowModel().rows;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  let body: ReactNode;
  if (list.isError && !list.data) {
    body = (
      <div className="p-6">
        {isNotFound(list.error) ? (
          <p className="text-muted-foreground text-sm">{NOT_FOUND_TEXT}</p>
        ) : (
          <ApiProblem error={list.error} title="The requirements couldn't be shown" />
        )}
      </div>
    );
  } else if (list.isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading requirements…</span>
      </div>
    );
  } else if (rows.length === 0 && total > 0) {
    // A page past the end (an old link, or a list that got shorter).
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="max-w-md text-sm">This page is past the end of the list.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => goTo(1)}>
          Go to the first page
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="max-w-md text-sm">
          {filtered
            ? 'No requirements match these filters.'
            : 'This framework has no requirements loaded for your organisation.'}
        </p>
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
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header, i) => {
                const col = columns[i]!;
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={col.sorts ? sortState : undefined}
                    className={cn(col.numeric && 'text-right', i === 0 && 'pl-4')}
                  >
                    {col.sorts ? (
                      <button
                        type="button"
                        onClick={toggleSort}
                        className="text-primary hover:text-primary/80 focus-visible:ring-ring/50 -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-[3px]"
                      >
                        {col.header}
                        {sortState === 'ascending' ? (
                          <ArrowUp className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden />
                        )}
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
            <TableRow
              key={row.id}
              className={cn(
                'even:bg-muted/30 hover:bg-accent/60',
                row.original.status === 'retired' && 'text-muted-foreground',
              )}
            >
              {row.getAllCells().map((cell, i) => (
                <TableCell
                  key={cell.id}
                  className={cn(columns[i]!.numeric && 'text-right tabular-nums', i === 0 && 'pl-4')}
                >
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
    <section aria-label="Requirements" className="bg-card rounded-lg border shadow-xs">
      <h2 className="border-b px-4 py-2.5 text-sm font-semibold">Requirements</h2>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="relative w-full sm:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search"
            placeholder="Search code or title"
            maxLength={MAX_SEARCH}
            className="pl-8"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Group"
          className="w-56"
          value={group ?? ''}
          onChange={(e) => setFilter('group', e.target.value)}
        >
          <option value="">Any group</option>
          {groups.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Coverage"
          className="w-40"
          value={search.coverage ?? ''}
          onChange={(e) => setFilter('coverage', e.target.value)}
        >
          <option value="">Any coverage</option>
          {COVERAGE_FILTERS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          className="w-32"
          value={search.status ?? 'active'}
          onChange={(e) => setFilter('status', e.target.value === 'active' ? '' : e.target.value)}
        >
          {STATUS_FILTERS.map((s) => (
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

      {list.data && total > 0 && rows.length > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
          <p>
            <span className="text-foreground font-semibold tabular-nums">
              {formatCount(first)}–{formatCount(last)}
            </span>{' '}
            of <span className="text-foreground font-semibold tabular-nums">{formatCount(total)}</span>{' '}
            {total === 1 ? 'requirement' : 'requirements'}
          </p>
          <div className="ml-auto flex items-center gap-3">
            <span className="tabular-nums">
              Page {formatCount(page)} of {formatCount(pages)}
            </span>
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

// ---- The page ---------------------------------------------------------------------------------

export function FrameworkPage({
  id,
  search,
  onSearchChange,
}: {
  id: string;
  search: RequirementSearch;
  onSearchChange: (next: RequirementSearch) => void;
}) {
  const framework = useFramework(id);

  if (framework.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the framework…</span>
      </div>
    );
  }
  // A framework missing or hidden is the same answer whatever the cause, even when the list had
  // shown it a moment ago.
  if (framework.isError && isNotFound(framework.error)) return <RecordNotFound back={<BackToFrameworks />} />;
  if (framework.isError && !framework.data) {
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-muted-foreground text-xs">
          <BackToFrameworks />
        </div>
        <ApiProblem error={framework.error} title="This framework couldn't be opened" />
      </div>
    );
  }

  return (
    <>
      <FrameworkHeader framework={framework.data} />
      <div className="px-8 py-6">
        <RequirementsTable framework={framework.data} search={search} onSearchChange={onSearchChange} />
      </div>
    </>
  );
}
