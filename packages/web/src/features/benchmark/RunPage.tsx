// A benchmark run's page (S8-010, D27 #13): the run's comparison of hybrid against vector-only search
// (D1), set out so the claim can be read off the page, with the evidence behind every number:
// - the header: when and by whom it started, its status, what it measured and its question set;
// - a running run's progress ("Running: N of M questions", and "No progress since …" after 30
//   minutes without new results), refreshed every 10 s without a reload; a failed run's code;
// - the verdict and every score, hybrid against vector only, then the same by question kind;
// - the times against the D48 targets, the graph path's runs and fallbacks, and the extraction
//   scores (runs with that part);
// - what it ran with (D45.8), and the per-question results with their details.
// Only the org's Admins see it (D50 `admin` cell). A run above the reader's clearance shows its
// summary and the hidden words, not its results or its settings' details (D51).
import { Link } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { useMe } from '@/features/records/useRecords';
import { BenchmarkNoAccess, RunProgress, RunStatusBadge } from './BenchmarkBits';
import { Results } from './Results';
import { RunSettings } from './RunSettings';
import { ExtractionTile, GraphTile, TimesTile } from './RunTiles';
import { ByKindTile, EveryScoreTile } from './ScoreTiles';
import {
  canViewBenchmark,
  isForbidden,
  isNotFound,
  isStalled,
  REFRESH_MS,
  useBenchmarkRun,
  useNow,
  useQuestionProgress,
  type BenchmarkRunSearch,
  type RunDetail,
} from './useBenchmark';
import { Verdict } from './Verdict';
import { countText, modesText, partsText, questionSetText, startedByText } from './words';

const SCREEN = SCREENS.find((s) => s.path === '/benchmark')!;

function BackLink() {
  return (
    <Link
      to="/benchmark"
      className="text-primary inline-flex items-center gap-1 rounded-sm text-xs font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      Benchmark runs
    </Link>
  );
}

function RunHeader({ run }: { run: RunDetail }) {
  return (
    <div className="bg-card border-b px-8 py-5">
      <BackLink />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Benchmark run of {formatMoment(run.startedAt)}</h1>
        <RunStatusBadge status={run.status} />
        <LabelBadge label={run.label} />
      </div>
      <dl className="text-muted-foreground mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt>Started by</dt>
          <dd className="text-foreground font-semibold">{startedByText(run.startedBy)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Parts</dt>
          <dd className="text-foreground">{partsText(run.parts)}</dd>
        </div>
        {run.modes.some((mode) => mode !== 'pipeline') ? (
          <div className="flex gap-1.5">
            <dt>Modes</dt>
            <dd className="text-foreground">{modesText(run.modes)}</dd>
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <dt>Questions</dt>
          <dd className="text-foreground">
            {countText(run.questionCount, 'question')}, {questionSetText(run.dataVersion)}
          </dd>
        </div>
        {run.finishedAt ? (
          <div className="flex gap-1.5">
            <dt>{run.status === 'failed' ? 'Failed' : 'Finished'}</dt>
            <dd className="text-foreground">{formatMoment(run.finishedAt)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function RunningPanel({ run }: { run: RunDetail }) {
  const progress = useQuestionProgress(run);
  const now = useNow(REFRESH_MS, run.status === 'running');
  if (run.status !== 'running') return null;
  return (
    <section aria-label="Progress" className="bg-card grid gap-2 rounded-lg border px-5 py-4 shadow-xs">
      <RunProgress run={run} progress={progress} stalled={isStalled(run, now)} />
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <RefreshCw className="size-3.5" aria-hidden />
        This page refreshes every 10 seconds while the run is running. Last results stored{' '}
        {formatMoment(run.lastActivityAt)}.
      </p>
    </section>
  );
}

function Body({
  run,
  search,
  onSearchChange,
}: {
  run: RunDetail;
  search: BenchmarkRunSearch;
  onSearchChange: (next: BenchmarkRunSearch) => void;
}) {
  return (
    <div className="grid min-w-0 gap-6 px-8 py-6">
      <RunningPanel run={run} />
      {run.status === 'failed' ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden />
          <AlertTitle>This run failed</AlertTitle>
          <AlertDescription>
            <p>
              The benchmark command gave up with the code{' '}
              <code className="rounded-sm bg-white/70 px-1 py-0.5 font-mono text-[12px]">
                {run.failure ?? 'unknown'}
              </code>
              . The scores below count only the results it stored before then.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Verdict run={run} />
      {/* The summary is computed when the run ends; until then only the verdict says so. */}
      {run.summary ? (
        <>
          <EveryScoreTile run={run} />
          <ByKindTile run={run} />
          <TimesTile run={run} />
          <div className="grid gap-6 lg:grid-cols-2 lg:[&>:last-child:nth-child(odd)]:col-span-2">
            <GraphTile run={run} />
            <ExtractionTile run={run} />
          </div>
        </>
      ) : null}
      <RunSettings run={run} />
      <Results run={run} search={search} onSearchChange={onSearchChange} />
    </div>
  );
}

export function RunPage({
  id,
  search,
  onSearchChange,
}: {
  id: string;
  search: BenchmarkRunSearch;
  onSearchChange: (next: BenchmarkRunSearch) => void;
}) {
  const me = useMe();
  const role = me.data?.role;
  const allowed = canViewBenchmark(role);
  const run = useBenchmarkRun(id, allowed);

  if (role === undefined) return null;
  if (!allowed || (isForbidden(run.error) && !run.data)) {
    return (
      <>
        <PageHeader title={SCREEN.label} summary={SCREEN.summary} />
        <BenchmarkNoAccess role={role} />
      </>
    );
  }
  if (run.isPending) {
    return (
      <>
        <div className="bg-card border-b px-8 py-5">
          <BackLink />
        </div>
        <div className="text-muted-foreground flex items-center gap-3 px-8 py-16 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading the benchmark run…</span>
        </div>
      </>
    );
  }
  if (!run.data) {
    return (
      <>
        <div className="bg-card border-b px-8 py-5">
          <BackLink />
        </div>
        <div className="px-8 py-6">
          <ApiProblem
            error={run.error}
            title={isNotFound(run.error) ? 'This benchmark run doesn’t exist' : 'The benchmark run couldn’t be shown'}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <RunHeader run={run.data} />
      <Body run={run.data} search={search} onSearchChange={onSearchChange} />
    </>
  );
}
