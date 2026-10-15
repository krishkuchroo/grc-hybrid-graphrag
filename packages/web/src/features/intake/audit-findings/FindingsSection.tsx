// "Audit findings" on a control or risk page (D213 (4)): the active findings that concern the record,
// from GET /api/v1/controls/:id/audit-findings or /risks/:id/audit-findings, in a ServiceNow related
// list (D2). Each row has the number (a link to the finding's page), title, severity, status in plain
// words, owner, due date (red when overdue, per `isFindingOverdue`, R15) and label. "Add audit
// finding" shows only when `canAddFinding` holds (the Auditor, D50), and the new finding concerns
// this record (R11). A role that never sees findings (the Viewer) gets no section at all, and only
// what the API returns is shown (D51). The API decides (D7).
import { Link } from '@tanstack/react-router';
import { AlarmClock } from 'lucide-react';
import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatDate } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { isNotFound, usePeople, type AnyRecord } from '@/features/records/useRecords';
import { ValueBadge } from '@/features/records/ValueBadge';
import { cn } from '@/lib/utils';
import { AddFindingDialog, FindingAdded } from './AddFindingDialog';
import {
  findingStatusText,
  localToday,
  mayAddFinding,
  mayViewFindings,
  overdue,
  useConcerningFindings,
  useViewer,
  type ConcernKind,
  type Finding,
} from './useFindings';

type Tone = 'blue' | 'orange' | 'amber' | 'green' | 'grey';

const DOT: Record<Tone, string> = {
  blue: 'bg-[#2b6cb0]',
  orange: 'bg-[#dd6b20]',
  amber: 'bg-[#d4a017]',
  green: 'bg-[#2f8a55]',
  grey: 'bg-[#8a969c]',
};

const STATUS_TONE: Record<string, Tone> = {
  open: 'blue',
  in_progress: 'orange',
  remediated: 'green',
  risk_accepted: 'amber',
  closed: 'grey',
};

/** A finding's status as a state indicator: a dot beside the plain name. */
export function FindingStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', DOT[STATUS_TONE[status] ?? 'grey'])} aria-hidden />
      <span>{findingStatusText(status)}</span>
    </span>
  );
}

/** A finding's severity, with the same scale as the other severities. */
export function SeverityBadge({ severity }: { severity: string }) {
  return <ValueBadge value={severity} />;
}

/** The due date; overdue ones in red with a clock and the word, so colour is never the only cue. */
export function DueDate({ finding, today }: { finding: Pick<Finding, 'dueDate' | 'findingStatus'>; today: string }) {
  if (!overdue(finding, today)) return <span className="whitespace-nowrap">{formatDate(finding.dueDate)}</span>;
  return (
    <span className="text-destructive inline-flex items-center gap-1 font-semibold whitespace-nowrap">
      <AlarmClock className="size-3.5 shrink-0" aria-hidden />
      {formatDate(finding.dueDate)}
      <span className="text-xs font-semibold">Overdue</span>
    </span>
  );
}

export function FindingsSection({ kind, record, noun }: { kind: ConcernKind; record: AnyRecord; noun: string }) {
  const title = 'Audit findings';
  const viewer = useViewer();
  const visible = mayViewFindings(viewer);
  const query = useConcerningFindings(kind, record.id, visible);
  const people = usePeople();
  const [added, setAdded] = useState<Finding | null>(null);

  // The Viewer never sees findings (D50); a record whose findings are hidden shows nothing either.
  if (!viewer || !visible) return null;
  if (query.isError && isNotFound(query.error)) return null;

  const today = localToday();
  const items = query.data ?? [];
  const nameOf = (userId: string) => (people.data ?? []).find((p) => p.id === userId)?.name ?? '—';
  const mayAdd = mayAddFinding(viewer);

  return (
    <section aria-label={title} className="bg-card rounded-lg border shadow-xs">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-1.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {query.data ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {items.length}
            </span>
          ) : null}
        </h2>
        <p role="status" className="text-muted-foreground flex min-w-0 items-center text-xs">
          {added ? <FindingAdded finding={added} kind={kind} /> : null}
        </p>
        {mayAdd ? (
          <div className="ml-auto">
            <AddFindingDialog record={record} noun={noun} viewer={viewer} onAdded={setAdded} />
          </div>
        ) : null}
      </div>
      {query.isPending ? (
        <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading the audit findings…</span>
        </div>
      ) : query.isError ? (
        <div className="p-4">
          <ApiProblem error={query.error} title="The audit findings couldn’t be loaded" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground grid gap-1 px-5 py-5 text-sm">
          <p>No audit findings concern this {noun}.</p>
          {mayAdd ? <p className="text-xs">Use Add audit finding to record what an audit found about it.</p> : null}
        </div>
      ) : (
        <Table aria-label={`Audit findings for ${record.number}`}>
          <TableHeader>
            <TableRow className="text-muted-foreground">
              <TableHead className="pl-5">
                Number <span className="font-normal">and title</span>
              </TableHead>
              <TableHead className="w-24">Severity</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-32">Owner</TableHead>
              <TableHead className="w-36">Due date</TableHead>
              <TableHead className="w-28 pr-5">Label</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((finding) => (
              <TableRow key={finding.id} className="hover:bg-muted/40">
                <TableCell className="max-w-0 min-w-48 py-1.5 pl-5">
                  <Link
                    to="/audit-findings/$id"
                    params={{ id: finding.id }}
                    className="text-primary font-semibold tabular-nums underline-offset-2 hover:underline"
                  >
                    {finding.number}
                  </Link>
                  <span className="text-muted-foreground block truncate text-xs" title={finding.name}>
                    {finding.name}
                  </span>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={finding.severity} />
                </TableCell>
                <TableCell>
                  <FindingStatusBadge status={finding.findingStatus} />
                </TableCell>
                <TableCell className="max-w-0 truncate">{nameOf(finding.owner)}</TableCell>
                <TableCell>
                  <DueDate finding={finding} today={today} />
                </TableCell>
                <TableCell className="pr-5">
                  <LabelBadge label={finding.label} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
