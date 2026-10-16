// One tab of the Analyst review queue (S5-005, D27 #8), in the ServiceNow list style (D2) of the
// S1 records kit: a dense table of findings with S5-002's summary, paged by the API (D47). Each
// row opens the finding's page. A link reads as plain words ("srv-pay-01 → exposed to → SQL
// injection") with its failed checks as short badges; every row has its document, label, age and
// status. A record the reader may not see reads "A record you can't see" (D51, D57).
import { reviewStatusText, type ReviewFindingKind, type ReviewFindingStatus } from '@grc/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, CircleCheck, FileText, Inbox } from 'lucide-react';
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KIND_TEXT } from '@/features/intake/permissions';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { cn } from '@/lib/utils';
import { FailedCheckBadge, FindingStatusBadge, LinkEndText, LinkPhrase, NamedRecordText } from './ReviewBits';
import { REVIEW_PAGE_SIZE, type FindingRow } from './useReview';
import {
  formatAge,
  HIDDEN_DOCUMENT_TEXT,
  KIND_TAB_TEXT,
  matchStepText,
  percent,
  personText,
  RECORD_KIND_TEXT,
} from './words';

interface Column {
  id: string;
  header: string;
  numeric?: boolean;
  /** The column that opens the finding: its content is the row's link. */
  opens?: boolean;
  /** Extra classes for the column's cells. */
  cellClass?: string;
  cell: (row: FindingRow) => ReactNode;
}

/** What the row's link says: the finding in a few words. */
function findingText(row: FindingRow): ReactNode {
  switch (row.kind) {
    case 'link':
      return (
        <LinkPhrase
          from={<LinkEndText end={row.summary.from} />}
          type={row.summary.type}
          to={<LinkEndText end={row.summary.to} />}
        />
      );
    case 'record':
      return (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-muted-foreground text-xs font-semibold whitespace-nowrap">
            New {RECORD_KIND_TEXT[row.summary.recordKind].toLowerCase()}
          </span>
          <span className="font-semibold [overflow-wrap:anywhere]">{row.summary.name}</span>
        </span>
      );
    case 'duplicate':
      return (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <NamedRecordText record={row.summary.kept} plain />
          <span className="text-muted-foreground text-xs">and</span>
          <NamedRecordText record={row.summary.other} plain />
        </span>
      );
    case 'mapping':
      return (
        <LinkPhrase
          from={<NamedRecordText record={row.summary.from} plain />}
          type={row.summary.type}
          to={<NamedRecordText record={row.summary.to} plain />}
        />
      );
  }
}

const OPEN: Column = { id: 'finding', header: '', opens: true, cell: findingText };

const FAILED_CHECKS: Column = {
  id: 'checks',
  header: 'Failed checks',
  cellClass: 'min-w-[12.5rem]',
  cell: (row) => {
    if (row.kind !== 'link') return null;
    if (row.summary.failedChecks.length === 0) {
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs whitespace-nowrap">
          <CircleCheck className="size-3.5 text-[#2f8a55]" aria-hidden />
          All checks passed
        </span>
      );
    }
    return (
      <span className="flex max-w-[16rem] flex-wrap gap-1">
        {row.summary.failedChecks.map((check) => (
          <FailedCheckBadge key={check} check={check} />
        ))}
      </span>
    );
  },
};

const DOCUMENT: Column = {
  id: 'document',
  header: 'Document',
  cell: (row) => {
    if (row.document) {
      return (
        <span className="flex max-w-[14rem] min-w-[9rem] items-start gap-1.5">
          <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="grid min-w-0">
            <span className="truncate" title={row.document.name}>
              {row.document.name}
            </span>
            <span className="text-muted-foreground text-xs">{KIND_TEXT[row.document.kind]}</span>
          </span>
        </span>
      );
    }
    if (row.kind === 'link' || row.kind === 'record') {
      return <span className="text-muted-foreground text-xs italic">{HIDDEN_DOCUMENT_TEXT}</span>;
    }
    return <span className="text-muted-foreground">—</span>;
  },
};

const LABEL: Column = { id: 'label', header: 'Label', cell: (row) => <LabelBadge label={row.label} /> };

const FOUND: Column = {
  id: 'found',
  header: 'Found',
  cell: (row) => (
    <time dateTime={row.createdAt} title={formatMoment(row.createdAt)} className="whitespace-nowrap">
      {formatAge(row.createdAt)}
    </time>
  ),
};

const STATUS: Column = {
  id: 'status',
  header: 'Status',
  cell: (row) => (
    <span className="grid justify-items-start gap-1">
      <FindingStatusBadge status={row.status} />
      {row.decidedBy ? (
        <span className="text-muted-foreground text-xs whitespace-nowrap">by {personText(row.decidedBy)}</span>
      ) : null}
    </span>
  ),
};

const COLUMNS: Readonly<Record<ReviewFindingKind, Column[]>> = {
  link: [{ ...OPEN, header: 'Link' }, FAILED_CHECKS, DOCUMENT, LABEL, FOUND, STATUS],
  record: [
    { ...OPEN, header: 'Proposed record' },
    {
      id: 'links',
      header: 'Links waiting on it',
      numeric: true,
      cell: (row) => (row.kind === 'record' ? row.summary.linkFindingCount : null),
    },
    DOCUMENT,
    LABEL,
    FOUND,
    STATUS,
  ],
  duplicate: [
    { ...OPEN, header: 'Records' },
    {
      id: 'recordKind',
      header: 'Kind',
      cell: (row) => (row.kind === 'duplicate' ? RECORD_KIND_TEXT[row.summary.recordKind] : null),
    },
    {
      id: 'how',
      header: 'How it was found',
      cell: (row) =>
        row.kind === 'duplicate' ? (
          <span className="grid whitespace-nowrap">
            <span>{matchStepText(row.summary.step)}</span>
            <span className="text-muted-foreground text-xs tabular-nums">{percent(row.summary.score)} alike</span>
          </span>
        ) : null,
    },
    LABEL,
    FOUND,
    STATUS,
  ],
  mapping: [{ ...OPEN, header: 'Mapping' }, LABEL, FOUND, STATUS],
};

const features = tableFeatures({});
const NO_ROWS: FindingRow[] = [];

export interface FindingsTableProps {
  kind: ReviewFindingKind;
  status: ReviewFindingStatus;
  rows: FindingRow[];
  isPending: boolean;
  isPlaceholderData: boolean;
  error: unknown;
  total: number | undefined;
  page: number;
  filtered: boolean;
  onClearFilters: () => void;
  onPage: (page: number) => void;
}

export function FindingsTable({
  kind,
  status,
  rows,
  isPending,
  isPlaceholderData,
  error,
  total,
  page,
  filtered,
  onClearFilters,
  onPage,
}: FindingsTableProps) {
  const navigate = useNavigate();
  const columns = COLUMNS[kind];
  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, FindingRow>();
    return columns.map((col) =>
      helper.display({ id: col.id, header: col.header, cell: (info) => col.cell(info.row.original) }),
    );
  }, [columns]);
  const table = useTable({ features, columns: tableColumns, data: rows.length > 0 ? rows : NO_ROWS });
  const tableRows = table.getRowModel().rows;

  /** A click anywhere on a row opens it, except on its own links and buttons. */
  const openRow = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString()) return;
    void navigate({ to: '/review/$id', params: { id } });
  };

  const count = total ?? 0;
  const first = count === 0 ? 0 : (page - 1) * REVIEW_PAGE_SIZE + 1;
  const last = Math.min(page * REVIEW_PAGE_SIZE, count);
  const tab = KIND_TAB_TEXT[kind].toLowerCase();

  let body: ReactNode;
  if (error && total === undefined) {
    body = (
      <div className="p-6">
        <ApiProblem error={error} title="The findings couldn’t be shown" />
      </div>
    );
  } else if (isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading findings…</span>
      </div>
    );
  } else if (tableRows.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
          <Inbox className="size-5" aria-hidden />
        </span>
        {filtered ? (
          <>
            <p className="max-w-md text-sm">No {tab} match these filters.</p>
            <Button type="button" variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          </>
        ) : status === 'pending' ? (
          <>
            <p className="max-w-md text-sm font-semibold">No {tab} are waiting for review.</p>
            <p className="text-muted-foreground max-w-md text-sm">
              When the extraction can’t settle something on its own, it waits here for an Analyst.
            </p>
          </>
        ) : (
          <p className="max-w-md text-sm">
            No {tab} are {reviewStatusText(status).toLowerCase()}.
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader className="bg-muted/70">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header, i) => (
                <TableHead key={header.id} className={cn(columns[i]!.numeric && 'text-right')}>
                  {columns[i]!.header}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody className={cn(isPlaceholderData && 'opacity-60')}>
          {tableRows.map((row) => (
            <TableRow
              key={row.original.id}
              onClick={(event) => openRow(event, row.original.id)}
              className="even:bg-muted/30 hover:bg-accent/60 cursor-pointer"
            >
              {row.getAllCells().map((cell, i) => {
                const col = columns[i]!;
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      'align-top',
                      col.numeric && 'text-right tabular-nums',
                      col.opens && 'min-w-[18rem] whitespace-normal',
                      col.cellClass,
                    )}
                  >
                    {col.opens ? (
                      <Link
                        to="/review/$id"
                        params={{ id: row.original.id }}
                        className="hover:text-primary focus-visible:ring-ring/50 block rounded-sm outline-none focus-visible:ring-[3px]"
                      >
                        <table.FlexRender cell={cell} />
                      </Link>
                    ) : (
                      <table.FlexRender cell={cell} />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <>
      {body}
      {total !== undefined && count > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
          <p>
            <span className="text-foreground font-semibold tabular-nums">
              {first}–{last}
            </span>{' '}
            of <span className="text-foreground font-semibold tabular-nums">{count}</span> findings
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={last >= count} onClick={() => onPage(page + 1)}>
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
