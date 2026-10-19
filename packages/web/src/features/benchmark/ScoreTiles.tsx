// A run's scores (S8-010), from the summary the API computed when it ended (`summariseBenchmark`):
// - "Every score": for each question part, hybrid and vector only side by side on each of its score
//   metrics, as a chart with the difference called out, and what each metric means;
// - "By question kind": the same per kind of question, as a chart of one chosen metric and a table
//   of every metric of the part.
// A score both modes measure is compared; the graph-query score is hybrid's alone.
import {
  BENCHMARK_METRIC_BY_NAME,
  BENCHMARK_PART_KINDS,
  BENCHMARK_QUESTION_PARTS,
  BENCHMARK_SCORE_METRICS,
  benchmarkKindText,
  benchmarkPartText,
  metricAppliesTo,
  summaryGroup,
  type BenchmarkItemKind,
  type BenchmarkQuestionPart,
  type BenchmarkScoreMetric,
  type BenchmarkSummary,
  type BenchmarkSummaryGroup,
} from '@grc/shared';
import { ChevronRight, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tile, TileEmpty } from '@/features/dashboard/Tile';
import { cn } from '@/lib/utils';
import { DiffPill, ModeLegend, ModeSwatch } from './BenchmarkBits';
import { ModeBars, type ModeBarRow } from './ModeBars';
import type { RunDetail } from './useBenchmark';
import { countText, formatScore, scoreDiff } from './words';

/** The score metrics of a part that both modes measure, for a kind (or overall). */
function comparedMetrics(part: BenchmarkQuestionPart, kind: BenchmarkItemKind | null): BenchmarkScoreMetric[] {
  return BENCHMARK_SCORE_METRICS.filter(
    (m) => metricAppliesTo(m, part, 'hybrid', kind) && metricAppliesTo(m, part, 'vector', kind),
  );
}

/** Every score metric of a part, hybrid-only ones included, for the per-kind table. */
function partMetrics(part: BenchmarkQuestionPart): BenchmarkScoreMetric[] {
  return BENCHMARK_SCORE_METRICS.filter((m) => metricAppliesTo(m, part, 'hybrid', null));
}

function meanOf(group: BenchmarkSummaryGroup | null, metric: BenchmarkScoreMetric): number | null {
  return group?.scores[metric]?.mean ?? null;
}

/** The question parts this run's summary has groups for. */
function partsWithScores(run: RunDetail): BenchmarkQuestionPart[] {
  return BENCHMARK_QUESTION_PARTS.filter(
    (part) =>
      run.parts.includes(part) &&
      (summaryGroup(run.summary, part, 'hybrid') !== null || summaryGroup(run.summary, part, 'vector') !== null),
  );
}

function NoScoresYet({ run }: { run: RunDetail }) {
  return (
    <TileEmpty icon={Hourglass}>
      {run.status === 'running' ? 'The scores appear when the run finishes.' : 'This run has no scored questions.'}
    </TileEmpty>
  );
}

function Definitions({ metrics }: { metrics: readonly BenchmarkScoreMetric[] }) {
  return (
    <Collapsible className="group/defs">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/defs:rotate-90" aria-hidden />
        What each score means
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="bg-muted/50 mt-2 grid gap-2.5 rounded-md border px-4 py-3">
          {metrics.map((name) => {
            const m = BENCHMARK_METRIC_BY_NAME[name];
            return (
              <div key={name} className="grid gap-0.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-3">
                <dt className="text-xs font-semibold">
                  {m.label}
                  {m.higherIsBetter ? null : (
                    <span className="text-muted-foreground font-normal"> (lower is better)</span>
                  )}
                </dt>
                <dd className="text-muted-foreground text-xs leading-relaxed">{m.definition}</dd>
              </div>
            );
          })}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Each part's score metrics, hybrid against vector only. */
export function EveryScoreTile({ run }: { run: RunDetail }) {
  const parts = partsWithScores(run);
  const bothModes = run.modes.includes('hybrid') && run.modes.includes('vector');
  const shown = BENCHMARK_QUESTION_PARTS.filter((part) => run.parts.includes(part));
  if (shown.length === 0) return null;
  return (
    <Tile id="every-score" title="Every score, hybrid against vector only" action={<ModeLegend />}>
      {!run.summary || parts.length === 0 ? (
        <NoScoresYet run={run} />
      ) : (
        <div className="grid gap-6">
          <div className={cn('grid gap-6', parts.length > 1 && 'xl:grid-cols-2')}>
            {parts.map((part) => {
              const hybrid = summaryGroup(run.summary, part, 'hybrid');
              const vector = summaryGroup(run.summary, part, 'vector');
              const metrics = bothModes ? comparedMetrics(part, null) : partMetrics(part);
              const rows: ModeBarRow[] = metrics.map((metric) => ({
                key: metric,
                label: BENCHMARK_METRIC_BY_NAME[metric].label,
                metric,
                hybrid: meanOf(hybrid, metric),
                vector: meanOf(vector, metric),
              }));
              const count = Math.max(hybrid?.count ?? 0, vector?.count ?? 0);
              return (
                <section key={part} aria-labelledby={`every-score-${part}`} className="grid content-start gap-2">
                  <h3 id={`every-score-${part}`} className="flex items-baseline gap-2 text-sm font-semibold">
                    {part === 'retrieval' ? 'Searches' : 'Answers'}
                    <span className="text-muted-foreground text-xs font-normal">
                      {countText(count, 'question')} in each mode
                    </span>
                  </h3>
                  <ModeBars rows={rows} />
                </section>
              );
            })}
          </div>
          <Definitions
            metrics={parts.flatMap((part) => (bothModes ? comparedMetrics(part, null) : partMetrics(part)))}
          />
        </div>
      )}
    </Tile>
  );
}

/** The kinds a part's summary has a group for, in either mode. */
function kindsOf(summary: BenchmarkSummary | null, part: BenchmarkQuestionPart): BenchmarkItemKind[] {
  return BENCHMARK_PART_KINDS[part].filter(
    (kind) =>
      summaryGroup(summary, part, 'hybrid', kind) !== null || summaryGroup(summary, part, 'vector', kind) !== null,
  );
}

function ScoreCell({
  metric,
  hybrid,
  vector,
  hybridOnly,
}: {
  metric: BenchmarkScoreMetric;
  hybrid: number | null;
  vector: number | null;
  hybridOnly: boolean;
}) {
  if (hybrid === null && vector === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-grid grid-cols-[auto_auto] items-center justify-end gap-x-2 gap-y-0.5">
      <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
        <ModeSwatch mode="hybrid" className="size-2" />
        <span className="font-semibold">{formatScore(metric, hybrid)}</span>
      </span>
      {hybridOnly ? <span /> : <DiffPill diff={scoreDiff(metric, hybrid, vector)} className="row-span-2" />}
      {hybridOnly ? (
        <span className="text-muted-foreground text-[11px]">Hybrid only</span>
      ) : (
        <span className="text-muted-foreground inline-flex items-center justify-end gap-1.5 tabular-nums">
          <ModeSwatch mode="vector" className="size-2" />
          {formatScore(metric, vector)}
        </span>
      )}
    </span>
  );
}

/** Each kind of question, every score of the chosen part, hybrid against vector only. */
export function ByKindTile({ run }: { run: RunDetail }) {
  const parts = partsWithScores(run);
  const [chosenPart, setPart] = useState<BenchmarkQuestionPart | null>(null);
  const part = chosenPart !== null && parts.includes(chosenPart) ? chosenPart : (parts[0] ?? null);
  const [chosenMetric, setMetric] = useState<BenchmarkScoreMetric | null>(null);
  const shown = BENCHMARK_QUESTION_PARTS.some((p) => run.parts.includes(p));
  if (!shown) return null;

  if (!run.summary || part === null) {
    return (
      <Tile id="by-kind" title="By question kind">
        <NoScoresYet run={run} />
      </Tile>
    );
  }

  const kinds = kindsOf(run.summary, part);
  const tableMetrics = partMetrics(part);
  const chartMetrics = tableMetrics.filter((m) => metricAppliesTo(m, part, 'vector', null));
  const metric =
    chosenMetric !== null && chartMetrics.includes(chosenMetric) ? chosenMetric : (chartMetrics[0] ?? null);
  const chartRows: ModeBarRow[] =
    metric === null
      ? []
      : kinds
          .filter((kind) => metricAppliesTo(metric, part, 'hybrid', kind))
          .map((kind) => ({
            key: kind,
            label: benchmarkKindText(kind),
            metric,
            hybrid: meanOf(summaryGroup(run.summary, part, 'hybrid', kind), metric),
            vector: meanOf(summaryGroup(run.summary, part, 'vector', kind), metric),
          }))
          .filter((row) => row.hybrid !== null || row.vector !== null);

  return (
    <Tile id="by-kind" title="By question kind" action={<ModeLegend />} bodyClassName="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {parts.length > 1 ? (
          <div role="group" aria-label="Part" className="bg-muted inline-flex rounded-md p-0.5">
            {parts.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === part}
                onClick={() => setPart(p)}
                className={cn(
                  'focus-visible:ring-ring/50 rounded-[5px] px-3 py-1 text-sm font-semibold outline-none focus-visible:ring-[3px]',
                  p === part ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p === 'retrieval' ? 'Searches' : 'Answers'}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm font-semibold">{part === 'retrieval' ? 'Searches' : 'Answers'}</p>
        )}
        {chartMetrics.length > 0 && metric !== null ? (
          <NativeSelect
            aria-label="Score in the chart"
            className="w-60"
            value={metric}
            onChange={(event) => setMetric(event.target.value as BenchmarkScoreMetric)}
          >
            {chartMetrics.map((m) => (
              <option key={m} value={m}>
                {BENCHMARK_METRIC_BY_NAME[m].label}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>

      {chartRows.length > 0 ? (
        <ModeBars rows={chartRows} labelWidth={150} />
      ) : (
        <p className="text-muted-foreground text-sm">No kind of question was scored on this.</p>
      )}

      <div className="-mx-5 overflow-x-auto border-t">
        <Table>
          <TableHeader className="bg-muted/70">
            <TableRow>
              <TableHead className="pl-5">Kind</TableHead>
              <TableHead className="text-right">Questions</TableHead>
              {tableMetrics.map((m) => (
                <TableHead key={m} className="text-right whitespace-normal">
                  {BENCHMARK_METRIC_BY_NAME[m].label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {kinds.map((kind) => {
              const hybrid = summaryGroup(run.summary, part, 'hybrid', kind);
              const vector = summaryGroup(run.summary, part, 'vector', kind);
              const count = Math.max(hybrid?.count ?? 0, vector?.count ?? 0);
              const skipped = Math.max(hybrid?.skipped ?? 0, vector?.skipped ?? 0);
              return (
                <TableRow key={kind} className="even:bg-muted/30">
                  <TableCell className="pl-5 font-semibold">{benchmarkKindText(kind)}</TableCell>
                  <TableCell className="text-right align-top tabular-nums">
                    <span className="grid">
                      <span>{count}</span>
                      {skipped > 0 ? <span className="text-muted-foreground text-xs">{skipped} skipped</span> : null}
                    </span>
                  </TableCell>
                  {tableMetrics.map((m) => (
                    <TableCell key={m} className="text-right align-top">
                      {metricAppliesTo(m, part, 'hybrid', kind) ? (
                        <ScoreCell
                          metric={m}
                          hybrid={meanOf(hybrid, m)}
                          vector={meanOf(vector, m)}
                          hybridOnly={!metricAppliesTo(m, part, 'vector', kind)}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">Not for this kind</span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        {benchmarkPartText(part)}: each kind’s scores are averaged over its questions that weren’t skipped. A question
        that failed before it could be scored gets the worst value on every score: 0, or 1 for made-up record numbers
        and planted instruction followed. A skipped question is counted but never averaged.
      </p>
    </Tile>
  );
}
