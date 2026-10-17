// The Benchmark screen's runs (S8-010, D27 #13), after ServiceNow's workspace lists (D2): the org's
// benchmark runs, newest first and paged (D47), each with when and by whom it started, its status
// (a running one with "Running: N of M questions", a failed one with its code), what it measured,
// where its questions came from, and its headline numbers, hybrid and vector only side by side. A
// list holding a running run asks again every 10 s. With no runs, the empty state gives the two
// commands that make one. Only the org's Admins see the screen (D50 `admin` cell): every other role
// gets the no-access screen, as it does when the API answers 403.
import {
  BENCHMARK_EMPTY_COMMANDS,
  BENCHMARK_PARTS,
  BENCHMARK_RUN_STATUSES,
  BENCHMARK_TEXT,
  benchmarkPartText,
  benchmarkStatusText,
  type BenchmarkPart,
  type BenchmarkRunStatus,
} from '@grc/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, FlaskConical, X } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { PageHeader } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { useMe } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { BenchmarkNoAccess, CommandLine, ModeLegend, RunProgress, RunStatusBadge } from './BenchmarkBits';
import { PairedBars } from './PairedBars';
import {
  canViewBenchmark,
  isForbidden,
  isStalled,
  RUNS_PAGE_SIZE,
  useBenchmarkRuns,
  useNow,
  useQuestionProgress,
  type BenchmarkListSearch,
  type RunRow,
} from './useBenchmark';
import { countText, modesText, questionSetText, startedByText } from './words';

const SCREEN = SCREENS.find((s) => s.path === '/benchmark')!;

/** The empty state: the plain words and the two commands that make a run (S8-001). */
export function BenchmarkEmpty() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <span className="bg-accent text-accent-foreground grid size-11 place-items-center rounded-full">
        <FlaskConical className="size-5" aria-hidden />
      </span>
      <div className="grid gap-1">
        <p className="text-sm font-semibold">{BENCHMARK_TEXT.empty}</p>
        <p className="text-muted-foreground max-w-lg text-sm">
          The first command builds a question set from generated data; the second runs it against your organisation in
          hybrid and vector-only mode, and the run shows here as it goes.
        </p>
      </div>
      <ol className="grid w-full max-w-2xl gap-2 text-left">
        {BENCHMARK_EMPTY_COMMANDS.map((command) => (
          <li key={command}>
            <CommandLine command={command} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Status({ run, now }: { run: RunRow; now: number }) {
  const progress = useQuestionProgress(run);
  return (
    <span className="grid justify-items-start gap-1.5">
      <RunStatusBadge status={run.status} />
      {run.status === 'running' ? (
        <RunProgress run={run} progress={progress} stalled={isStalled(run, now)} compact />
      ) : null}
      {run.status === 'failed' && run.failure ? (
        <span className="text-xs">
          <span className="text-muted-foreground">Code </span>
          <code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-[11.5px]">{run.failure}</code>
        </span>
      ) : null}
    </span>
  );
}

function Headline({ run, metric }: { run: RunRow; metric: 'contextRecall' | 'answerCorrectness' }) {
  const part: BenchmarkPart = metric === 'contextRecall' ? 'retrieval' : 'answers';
  const name = metric === 'contextRecall' ? 'context_recall' : 'answer_correctness';
  let empty = 'Not measured';
  if (run.parts.includes(part)) empty = run.status === 'running' ? 'When it finishes' : 'No scored questions';
  return (
    <PairedBars
      metric={name}
      hybrid={run.headline.hybrid[metric]}
      vector={run.headline.vector[metric]}
      emptyText={empty}
    />
  );
}

/** The run's parts as chips, then its modes, questions and question set in a line. */
function Measured({ run }: { run: RunRow }) {
  const modes = run.modes.filter((mode) => mode !== 'pipeline');
  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap gap-1">
        {run.parts.map((part) => (
          <span
            key={part}
            className="border-border bg-card rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold"
          >
            {benchmarkPartText(part)}
          </span>
        ))}
      </span>
      <span className="text-muted-foreground text-xs leading-snug [overflow-wrap:anywhere]">
        {modes.length > 0 ? `${modesText(modes)}, ` : ''}
        {countText(run.questionCount, 'question')}, {questionSetText(run.dataVersion)}.
      </span>
    </span>
  );
}

function RunsTable({ runs, now, dimmed }: { runs: readonly RunRow[]; now: number; dimmed: boolean }) {
  const navigate = useNavigate();
  /** A click anywhere on a row opens it, except on its own links and buttons. */
  const openRow = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString()) return;
    void navigate({ to: '/benchmark/$id', params: { id } });
  };
  return (
    <Table>
      <TableHeader className="bg-muted/70">
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>What it measured</TableHead>
          <TableHead>Context recall</TableHead>
          <TableHead>Answer correctness</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={cn(dimmed && 'opacity-60')}>
        {runs.map((run) => (
          <TableRow
            key={run.id}
            onClick={(event) => openRow(event, run.id)}
            className="even:bg-muted/30 hover:bg-accent/60 cursor-pointer"
          >
            <TableCell className="align-top">
              <Link
                to="/benchmark/$id"
                params={{ id: run.id }}
                className="hover:text-primary focus-visible:ring-ring/50 grid rounded-sm outline-none focus-visible:ring-[3px]"
              >
                <time dateTime={run.startedAt} className="font-semibold whitespace-nowrap">
                  {formatMoment(run.startedAt)}
                </time>
                <span className="text-muted-foreground text-xs">by {startedByText(run.startedBy)}</span>
              </Link>
              <LabelBadge label={run.label} className="mt-1.5" />
            </TableCell>
            <TableCell className="align-top">
              <Status run={run} now={now} />
            </TableCell>
            <TableCell className="max-w-[17rem] min-w-[13rem] align-top whitespace-normal">
              <Measured run={run} />
            </TableCell>
            <TableCell className="align-top">
              <Headline run={run} metric="contextRecall" />
            </TableCell>
            <TableCell className="align-top">
              <Headline run={run} metric="answerCorrectness" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function BenchmarkList({
  search,
  onSearchChange,
}: {
  search: BenchmarkListSearch;
  onSearchChange: (next: BenchmarkListSearch) => void;
}) {
  const me = useMe();
  const role = me.data?.role;
  const allowed = canViewBenchmark(role);
  const runs = useBenchmarkRuns(search, allowed);
  const anyRunning = runs.data?.items.some((run) => run.status === 'running') ?? false;
  const now = useNow(30_000, anyRunning);

  const header = <PageHeader title={SCREEN.label} summary={SCREEN.summary} />;
  if (role === undefined) return header;
  if (!allowed || (isForbidden(runs.error) && !runs.data)) {
    return (
      <>
        {header}
        <BenchmarkNoAccess role={role} />
      </>
    );
  }

  const filtered = search.status !== undefined || search.part !== undefined;
  const change = (patch: Partial<BenchmarkListSearch>) => {
    const next: BenchmarkListSearch = { ...search, ...patch };
    delete next.page;
    for (const key of Object.keys(next) as Array<keyof BenchmarkListSearch>) {
      if (next[key] === undefined) delete next[key];
    }
    onSearchChange(next);
  };
  const page = search.page ?? 1;
  const total = runs.data?.total ?? 0;
  const items = runs.data?.items ?? [];
  const first = total === 0 ? 0 : (page - 1) * RUNS_PAGE_SIZE + 1;
  const last = Math.min(page * RUNS_PAGE_SIZE, total);

  let body: ReactNode;
  if (runs.isError && !runs.data) {
    body = (
      <div className="p-6">
        <ApiProblem error={runs.error} title="The benchmark runs couldn’t be shown" />
      </div>
    );
  } else if (runs.isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading benchmark runs…</span>
      </div>
    );
  } else if (items.length === 0 && filtered) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="max-w-md text-sm">No benchmark runs match these filters.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => change({ status: undefined, part: undefined })}
        >
          Clear filters
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    body = <BenchmarkEmpty />;
  } else {
    body = <RunsTable runs={items} now={now} dimmed={runs.isPlaceholderData} />;
  }

  return (
    <>
      {header}
      <div className="flex min-w-0 flex-col gap-4 px-8 py-6">
        <section aria-label="Benchmark runs" className="bg-card min-w-0 rounded-lg border shadow-xs">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <NativeSelect
              aria-label="Status"
              className="w-40"
              value={search.status ?? ''}
              onChange={(event) =>
                change({ status: (event.target.value || undefined) as BenchmarkRunStatus | undefined })
              }
            >
              <option value="">Every status</option>
              {BENCHMARK_RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {benchmarkStatusText(s)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Part"
              className="w-44"
              value={search.part ?? ''}
              onChange={(event) => change({ part: (event.target.value || undefined) as BenchmarkPart | undefined })}
            >
              <option value="">Every part</option>
              {BENCHMARK_PARTS.map((p) => (
                <option key={p} value={p}>
                  {benchmarkPartText(p)}
                </option>
              ))}
            </NativeSelect>
            {filtered ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => change({ status: undefined, part: undefined })}
              >
                <X aria-hidden />
                Clear
              </Button>
            ) : null}
            <ModeLegend className="ml-auto" />
          </div>

          {body}

          {runs.data && total > 0 ? (
            <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
              <p>
                <span className="text-foreground font-semibold tabular-nums">
                  {first}–{last}
                </span>{' '}
                of <span className="text-foreground font-semibold tabular-nums">{total}</span>{' '}
                {total === 1 ? 'run' : 'runs'}
                {anyRunning ? <span>. The list refreshes every 10 seconds while a run is running.</span> : null}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => onSearchChange({ ...search, page: page - 1 > 1 ? page - 1 : undefined })}
                >
                  <ChevronLeft aria-hidden />
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={last >= total}
                  onClick={() => onSearchChange({ ...search, page: page + 1 })}
                >
                  Next
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          ) : null}
        </section>
        {runs.data && total > 0 ? (
          <p className="text-muted-foreground text-xs">
            {countText(total, 'run')} in this organisation. Context recall is the share of the expected records a search
            put in the answer’s context; answer correctness is the share an answer named.
          </p>
        ) : null}
      </div>
    </>
  );
}
