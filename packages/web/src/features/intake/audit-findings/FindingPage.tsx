// An audit finding's own page at /audit-findings/$id (D213 (4)), built on S1's records kit and laid
// out like every record page (D2): the number as the title with its status and label, every D213 (2)
// field in a two-column sheet, the controls and risks it concerns, and the owner and dates at the
// side, under a remediation panel that counts the days to the due date. Edit and Retire show only
// for a role that edits findings (the Auditor, D50); the API decides anyway (D7). A stale save (409,
// D69) keeps what was typed and offers Reload; a missing or hidden finding gets the one not-found
// page, whatever the cause (D51), and a role that never sees findings (the Viewer) gets it too.
import { useCanGoBack, useRouter, Link } from '@tanstack/react-router';
import { Archive, ChevronLeft, CircleCheck, Pencil, RefreshCw, SearchX, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError, type PatchAuditFindingsIdBody } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiProblem, NOT_FOUND_TEXT } from '@/features/records/ApiProblem';
import { formatDate, formatMoment, words } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { editLabelChoices } from '@/features/records/permissions';
import { RecordNotFound, StatusBadge, type DetailItem } from '@/features/records/RecordPage';
import { isNotFound, isStale, usePeople } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { FindingForm, findingValues } from './AddFindingDialog';
import { ConcernsList } from './ConcernsList';
import { DueDate, FindingStatusBadge, SeverityBadge } from './FindingsSection';
import {
  daysUntil,
  findingStatusText,
  localToday,
  mayEditFinding,
  overdue,
  useFinding,
  useRetireFinding,
  useUpdateFinding,
  useViewer,
  type Finding,
} from './useFindings';

/** Back to wherever the person came from (a control or risk page); Home when the page was opened
 * on its own. Findings have no list of their own and no menu item (D213 (4)). */
function Back() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const className = 'hover:text-primary inline-flex items-center gap-1 font-semibold';
  if (canGoBack) {
    return (
      <button type="button" className={className} onClick={() => router.history.back()}>
        <ChevronLeft className="size-3.5" aria-hidden />
        Back
      </button>
    );
  }
  return (
    <Link to="/" className={className}>
      <ChevronLeft className="size-3.5" aria-hidden />
      Home
    </Link>
  );
}

function Sheet({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 px-5 py-5 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className={cn('grid gap-1', item.wide && 'sm:col-span-2')}>
          <dt className="text-muted-foreground text-xs font-semibold">{item.label}</dt>{' '}
          <dd className="text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('bg-card rounded-lg border shadow-xs', className)}>
      <h2 className="border-b px-5 py-2.5 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Long text as typed, line breaks kept. */
function Prose({ text }: { text: string }) {
  return <p className="max-w-[75ch] leading-relaxed whitespace-pre-wrap">{text}</p>;
}

const SEVERITY_RAIL: Record<string, string> = {
  critical: 'bg-[#b42318]',
  high: 'bg-[#dd6b20]',
  medium: 'bg-[#d4a017]',
  low: 'bg-[#2f8a55]',
};

/** The remediation clock: how many days are left to the due date, or how far past it an open
 * finding is (R15); a finding no longer open says where it ended. */
function RemediationPanel({ finding, today }: { finding: Finding; today: string }) {
  const days = daysUntil(finding.dueDate, today);
  const open = finding.findingStatus === 'open' || finding.findingStatus === 'in_progress';
  const late = overdue(finding, today);

  let figure: ReactNode;
  if (!open) {
    figure = (
      <div className="grid gap-1">
        <p className="text-2xl leading-none font-bold">{findingStatusText(finding.findingStatus)}</p>
        {finding.findingStatus === 'closed' && finding.closedDate ? (
          <p className="text-muted-foreground text-xs">Closed on {formatDate(finding.closedDate)}</p>
        ) : null}
      </div>
    );
  } else if (days === null) {
    figure = <p className="text-muted-foreground text-sm">No valid due date.</p>;
  } else if (days === 0) {
    figure = <p className="text-3xl leading-none font-bold text-[#9a3a0b]">Due today</p>;
  } else {
    const count = Math.abs(days);
    figure = (
      <p className={cn('flex items-baseline gap-2', late ? 'text-destructive' : 'text-foreground')}>
        <span className="text-4xl leading-none font-bold tabular-nums">{count}</span>
        <span className="text-sm font-semibold">
          {count === 1 ? 'day' : 'days'} {late ? 'overdue' : 'left'}
        </span>
      </p>
    );
  }

  return (
    <section aria-label="Remediation" className="bg-card relative overflow-hidden rounded-lg border shadow-xs">
      <span
        className={cn('absolute inset-y-0 left-0 w-1', SEVERITY_RAIL[finding.severity] ?? 'bg-muted-foreground')}
        aria-hidden
      />
      <h2 className="border-b px-5 py-2.5 text-sm font-semibold">Remediation</h2>
      <div className="grid gap-3 px-5 py-4">
        {figure}
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt>Severity</dt>
          <dd className="text-foreground">
            <SeverityBadge severity={finding.severity} />
          </dd>
          <dt>Due</dt>
          <dd className="text-foreground">{formatDate(finding.dueDate)}</dd>
          <dt>Identified</dt>
          <dd className="text-foreground">{formatDate(finding.identifiedDate)}</dd>
        </dl>
      </div>
    </section>
  );
}

/** Retire asks first (D69: findings are retired, never deleted); a refusal stays in the dialog. */
function RetireFindingDialog({
  number,
  pending,
  error,
  onConfirm,
  onOpen,
}: {
  number: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => Promise<unknown>;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline">
          <Archive aria-hidden />
          Retire
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {number}?</AlertDialogTitle>
          <AlertDialogDescription>
            The finding leaves the control and risk pages but is kept, with its history, in the audit trail. Its own
            page stays open to everyone who could see it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <ApiProblem
            error={error}
            title={isStale(error) ? 'This record changed since you opened it' : 'The audit finding wasn’t retired'}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              try {
                await onConfirm();
                setOpen(false);
              } catch {
                // The refusal shows in the dialog.
              }
            }}
          >
            {pending ? 'Retiring…' : 'Retire audit finding'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FindingPage({ id }: { id: string }) {
  const viewer = useViewer();
  const people = usePeople();
  const query = useFinding(id);
  const update = useUpdateFinding(id);
  const retire = useRetireFinding(id);
  /** The finding as it was when the form opened: its version goes with the save (D69). */
  const [opened, setOpened] = useState<Finding | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const back = <Back />;

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the audit finding…</span>
      </div>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) return <RecordNotFound back={back} />;
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-muted-foreground text-xs">{back}</div>
        <ApiProblem error={query.error} title="This audit finding couldn't be opened" />
      </div>
    );
  }

  const finding = query.data;
  const today = localToday();
  const nameOf = (userId: string) => (people.data ?? []).find((p) => p.id === userId)?.name ?? '—';
  const mayEdit = mayEditFinding(viewer, finding);
  const editing = opened !== null;

  const startEdit = () => {
    update.reset();
    setDone(null);
    setOpened(finding);
  };

  const reload = async () => {
    const latest = await query.refetch();
    if (latest.data) {
      update.reset();
      setOpened(latest.data);
    }
  };

  let notice: ReactNode = null;
  const saveError = update.error;
  if (saveError && isStale(saveError)) {
    notice = (
      <Alert variant="destructive" role="alert">
        <TriangleAlert aria-hidden />
        <AlertTitle>This record changed since you opened it</AlertTitle>
        <AlertDescription>
          <p>
            Someone else saved it while you were editing, so your changes weren&apos;t saved. Your typed changes are
            still in the form below. Reload to get the latest version, then re-apply your changes and save again.
          </p>
          <Button type="button" size="sm" variant="outline" className="mt-1" onClick={() => void reload()}>
            <RefreshCw aria-hidden />
            Reload latest version
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (saveError && isNotFound(saveError)) {
    notice = (
      <Alert variant="destructive" role="alert">
        <SearchX aria-hidden />
        <AlertTitle>Your changes weren&apos;t saved</AlertTitle>
        <AlertDescription>
          <p>{NOT_FOUND_TEXT}</p>
        </AlertDescription>
      </Alert>
    );
  } else if (saveError) {
    notice = (
      <ApiProblem
        error={saveError}
        title={
          saveError instanceof ApiError && saveError.status === 403
            ? 'You can’t save these changes'
            : 'Your changes weren’t saved'
        }
      />
    );
  }

  const details: DetailItem[] = [
    { label: 'Title', value: finding.name, wide: true },
    { label: 'Severity', value: <SeverityBadge severity={finding.severity} /> },
    { label: 'Status', value: <FindingStatusBadge status={finding.findingStatus} /> },
    { label: 'Date identified', value: formatDate(finding.identifiedDate) },
    { label: 'Due date', value: <DueDate finding={finding} today={today} /> },
    {
      label: 'Closed date',
      value: finding.closedDate ? formatDate(finding.closedDate) : <span className="text-muted-foreground">—</span>,
    },
    { label: 'Source or audit reference', value: finding.sourceReference },
    { label: 'Root cause', value: <Prose text={finding.rootCause} />, wide: true },
    { label: 'Remediation plan', value: <Prose text={finding.remediationPlan} />, wide: true },
    {
      label: 'Description',
      value: finding.description ? (
        <Prose text={finding.description} />
      ) : (
        <span className="text-muted-foreground">None</span>
      ),
      wide: true,
    },
  ];

  return (
    <>
      <div className="bg-card border-b px-8 pt-4 pb-5">
        <nav aria-label="Breadcrumb" className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
          {back}
          <span aria-hidden>/</span>
          <span>Audit finding</span>
        </nav>
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight tabular-nums">{finding.number}</h1>
              <StatusBadge status={finding.status} />
              <LabelBadge label={finding.label} />
            </div>
            <p className="text-muted-foreground max-w-[70ch] text-sm">{finding.name}</p>
          </div>
          {mayEdit && !editing ? (
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" onClick={startEdit}>
                <Pencil aria-hidden />
                Edit
              </Button>
              {finding.status === 'active' ? (
                <RetireFindingDialog
                  number={finding.number}
                  pending={retire.isPending}
                  error={retire.error}
                  onOpen={() => retire.reset()}
                  onConfirm={async () => {
                    await retire.mutateAsync(finding.version);
                    setDone(`${finding.number} was retired. It no longer shows on the control and risk pages.`);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-4">
          {done ? (
            <Alert variant="info" role="status">
              <CircleCheck aria-hidden />
              <AlertDescription>
                <p>{done}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {editing ? (
            <Panel title="Edit audit finding">
              <div className="px-5 py-5">
                <FindingForm
                  key={opened.version}
                  mode="edit"
                  initial={findingValues(opened)}
                  version={opened.version}
                  labelChoices={viewer ? editLabelChoices(viewer, opened.label) : [opened.label]}
                  submitText="Save changes"
                  pending={update.isPending}
                  notice={notice}
                  onCancel={() => {
                    update.reset();
                    setOpened(null);
                  }}
                  onSubmit={({ changed }) => {
                    if (Object.keys(changed).length === 0) {
                      setOpened(null);
                      return;
                    }
                    update.mutate({ ...changed, version: opened.version } as PatchAuditFindingsIdBody, {
                      onSuccess: () => {
                        setOpened(null);
                        setDone('Changes saved.');
                      },
                    });
                  }}
                />
              </div>
            </Panel>
          ) : (
            <Panel title="Details">
              <Sheet items={details} />
            </Panel>
          )}
          <ConcernsList finding={finding} viewer={viewer} />
        </div>

        <aside className="grid content-start gap-4">
          <RemediationPanel finding={finding} today={today} />
          <Panel title="Record">
            <Sheet
              items={[
                { label: 'Owner', value: nameOf(finding.owner), wide: true },
                { label: 'Label', value: <LabelBadge label={finding.label} />, wide: true },
                { label: 'Status', value: words(finding.status) },
                { label: 'Origin', value: words(finding.origin) },
                {
                  label: 'Created',
                  value: `${formatMoment(finding.createdAt)} by ${nameOf(finding.createdBy)}`,
                  wide: true,
                },
                {
                  label: 'Updated',
                  value: `${formatMoment(finding.updatedAt)} by ${nameOf(finding.updatedBy)}`,
                  wide: true,
                },
              ]}
            />
          </Panel>
        </aside>
      </div>
    </>
  );
}
