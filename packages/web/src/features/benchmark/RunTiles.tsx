// A run's times, graph path and extraction scores (S8-010), from the summary the API computed when
// it ended (`summariseBenchmark`):
// - Times: each step's 50th and 95th percentile (nearest rank) per mode, and each D48 target judged
//   at the 95th with a pass or fail badge (D48: vector search and running the graph query 95% under
//   500 ms, first words within 25 s, the full answer within 60 s).
// - Graph path: how often hybrid's graph query ran, and why it fell back when it didn't (D45.7).
// - Extraction: the seven ratios, each from its counts, for runs with that part (D42, D24, D38).
import {
  BENCHMARK_METRIC_BY_NAME,
  BENCHMARK_TARGETS,
  EXTRACTION_RATIO_METRICS,
  GRAPH_FALLBACK_REASONS,
  graphFallbackText,
  summaryGroup,
  type BenchmarkSummaryGroup,
  type BenchmarkTimeMetric,
} from '@grc/shared';
import { Hourglass, Network, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration, RECORD_KIND_TEXT } from '@/features/chat/words';
import { Tile, TileEmpty } from '@/features/dashboard/Tile';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { cn } from '@/lib/utils';
import { ModeSwatch, TargetBadge } from './BenchmarkBits';
import type { RunDetail } from './useBenchmark';
import { percentText, QUESTION_MODES } from './words';

function NoScoresYet({ run }: { run: RunDetail }) {
  return (
    <TileEmpty icon={Hourglass}>
      {run.status === 'running' ? 'These appear when the run finishes.' : 'Nothing was measured for this.'}
    </TileEmpty>
  );
}

// ---- Times ----------------------------------------------------------------------------------------

const TIME_ROWS: ReadonlyArray<{ metric: BenchmarkTimeMetric; part: 'retrieval' | 'answers' }> = [
  { metric: 'embedding_ms', part: 'retrieval' },
  { metric: 'vector_search_ms', part: 'retrieval' },
  { metric: 'graph_query_writing_ms', part: 'retrieval' },
  { metric: 'graph_query_running_ms', part: 'retrieval' },
  { metric: 'first_words_ms', part: 'answers' },
  { metric: 'answer_total_ms', part: 'answers' },
];

/** A D48 limit as D48 writes it: `500 ms`, `25 s`, `60 s`. */
function limitText(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

function TimeCells({
  group,
  metric,
  measured,
}: {
  group: BenchmarkSummaryGroup | null;
  metric: BenchmarkTimeMetric;
  measured: boolean;
}) {
  if (!measured) {
    return (
      <TableCell colSpan={2} className="text-muted-foreground text-center text-xs">
        Hybrid only
      </TableCell>
    );
  }
  const stat = group?.times[metric];
  const target = group?.targets.find((t) => t.metric === metric);
  if (!stat || stat.n === 0) {
    return (
      <TableCell colSpan={2} className="text-muted-foreground text-center text-xs">
        Not measured
      </TableCell>
    );
  }
  return (
    <>
      <TableCell className="text-right whitespace-nowrap tabular-nums">{formatDuration(stat.p50)}</TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center justify-end gap-2">
          <span className="grid text-right">
            <span className="font-semibold whitespace-nowrap tabular-nums">{formatDuration(stat.p95)}</span>
            <span className="text-muted-foreground text-[11px] whitespace-nowrap">over {formatCount(stat.n)}</span>
          </span>
          {target ? <TargetBadge pass={target.pass} /> : null}
        </span>
      </TableCell>
    </>
  );
}

export function TimesTile({ run }: { run: RunDetail }) {
  const rows = TIME_ROWS.filter((row) => run.parts.includes(row.part));
  const modes = QUESTION_MODES.filter((mode) => run.modes.includes(mode));
  if (rows.length === 0 || modes.length === 0) return null;
  return (
    <Tile id="times" title="Times against the D48 targets" bodyClassName={run.summary ? 'p-0' : undefined}>
      {!run.summary ? (
        <NoScoresYet run={run} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/70">
                <TableRow>
                  <TableHead rowSpan={2} className="pl-5 align-bottom">
                    Step
                  </TableHead>
                  <TableHead rowSpan={2} className="align-bottom">
                    Target
                  </TableHead>
                  {modes.map((mode) => (
                    <TableHead key={mode} colSpan={2} className="border-l text-center">
                      <span className="inline-flex items-center gap-1.5">
                        <ModeSwatch mode={mode} />
                        {mode === 'hybrid' ? 'Hybrid' : 'Vector only'}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow>
                  {modes.map((mode) => (
                    <ModeHeads key={mode} />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ metric, part }) => {
                  const m = BENCHMARK_METRIC_BY_NAME[metric];
                  const target = BENCHMARK_TARGETS.find((t) => t.metric === metric);
                  return (
                    <TableRow key={metric} className="even:bg-muted/30">
                      <TableCell className="max-w-[18rem] pl-5 whitespace-normal">
                        <span className="grid gap-0.5">
                          <span className="font-semibold">{m.label}</span>
                          <span className="text-muted-foreground text-xs leading-snug">{m.definition}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-sm whitespace-normal">
                        {target ? (
                          <span className="grid">
                            <span className="font-semibold">
                              95% {target.inclusive ? 'within' : 'under'} {limitText(target.limitMs)}
                            </span>
                            <span className="text-muted-foreground text-xs">D48</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">No target</span>
                        )}
                      </TableCell>
                      {modes.map((mode) => (
                        <TimeCells
                          key={mode}
                          group={summaryGroup(run.summary, part, mode)}
                          metric={metric}
                          measured={m.modes.includes(mode)}
                        />
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground border-t px-5 py-3 text-xs leading-relaxed">
            Percentiles are by nearest rank over every question that ran the step, skipped ones included. A target
            passes when the 95th percentile meets it.
          </p>
        </>
      )}
    </Tile>
  );
}

function ModeHeads() {
  return (
    <>
      <TableHead className="border-l text-right">50th</TableHead>
      <TableHead className="text-right">95th</TableHead>
    </>
  );
}

// ---- Graph path -----------------------------------------------------------------------------------

function SplitBar({ ran, total }: { ran: number; total: number }) {
  const share = total === 0 ? 0 : (ran / total) * 100;
  return (
    <div aria-hidden className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#f3dfb9]">
      <span className="bg-primary h-full" style={{ width: `${share}%` }} />
    </div>
  );
}

export function GraphTile({ run }: { run: RunDetail }) {
  if (!run.modes.includes('hybrid') || !(run.parts.includes('retrieval') || run.parts.includes('answers'))) {
    return (
      <Tile id="graph-path" title="Graph path">
        <TileEmpty icon={Network}>This run didn’t use hybrid mode, so no graph query was written.</TileEmpty>
      </Tile>
    );
  }
  if (!run.summary) {
    return (
      <Tile id="graph-path" title="Graph path">
        <NoScoresYet run={run} />
      </Tile>
    );
  }
  const searches = summaryGroup(run.summary, 'retrieval', 'hybrid');
  const answers = summaryGroup(run.summary, 'answers', 'hybrid');
  const stat = searches?.scores.graph_query_ran;
  const scored = stat?.n ?? 0;
  const ran = stat?.mean !== null && stat?.mean !== undefined ? Math.round(stat.mean * scored) : 0;
  const fallbacks = GRAPH_FALLBACK_REASONS.map((reason) => ({
    reason,
    searches: searches?.graphFallbacks[reason] ?? 0,
    answers: answers?.graphFallbacks[reason] ?? 0,
  }));
  const anyFallback = fallbacks.some((f) => f.searches > 0 || f.answers > 0);

  return (
    <Tile id="graph-path" title="Graph path" bodyClassName="grid content-start gap-5">
      {searches && scored > 0 ? (
        <div className="grid gap-2">
          <p className="flex items-baseline gap-2">
            <span className="text-primary text-[1.875rem] leading-none font-bold tabular-nums">
              {percentText(stat?.mean)}
            </span>
            <span className="text-sm">
              The graph query ran for {formatCount(ran)} of {formatCount(scored)} hybrid searches.
            </span>
          </p>
          <SplitBar ran={ran} total={scored} />
          <p className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-primary size-2.5 rounded-[3px]" aria-hidden />
              Ran in the org’s database
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px] bg-[#f3dfb9]" aria-hidden />
              Fell back to documents only
            </span>
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No hybrid search was scored on whether its graph query ran.</p>
      )}

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Fallbacks by reason</h3>
        {anyFallback ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-0">Reason</TableHead>
                {searches ? <TableHead className="text-right">Searches</TableHead> : null}
                {answers ? <TableHead className="pr-0 text-right">Answers</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {fallbacks.map((f) => (
                <TableRow key={f.reason} className={cn(f.searches === 0 && f.answers === 0 && 'text-muted-foreground')}>
                  <TableCell className="pl-0 text-sm whitespace-normal">{graphFallbackText(f.reason)}</TableCell>
                  {searches ? (
                    <TableCell className={cn('text-right tabular-nums', f.searches > 0 && 'font-bold')}>
                      {f.searches}
                    </TableCell>
                  ) : null}
                  {answers ? (
                    <TableCell className={cn('pr-0 text-right tabular-nums', f.answers > 0 && 'font-bold')}>
                      {f.answers}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">The graph query never fell back.</p>
        )}
      </div>
    </Tile>
  );
}

// ---- Extraction -----------------------------------------------------------------------------------

function Ratio({
  label,
  definition,
  value,
  numerator,
  denominator,
}: {
  label: string;
  definition: string;
  value: number | null;
  numerator: number;
  denominator: number;
}) {
  return (
    <li className="grid gap-1.5">
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-semibold">{label}</span>
        <span className="ml-auto text-lg leading-none font-bold tabular-nums">{percentText(value)}</span>
      </div>
      <div aria-hidden className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <span
          className="bg-primary block h-full rounded-full"
          style={{ width: `${value === null ? 0 : Math.min(1, Math.max(0, value)) * 100}%` }}
        />
      </div>
      <p className="text-muted-foreground flex gap-3 text-xs leading-snug">
        <span className="min-w-0 flex-1">{definition}</span>
        <span className="text-foreground shrink-0 font-semibold tabular-nums">
          {denominator === 0 ? 'None to count' : `${formatCount(numerator)} of ${formatCount(denominator)}`}
        </span>
      </p>
    </li>
  );
}

function Unmatched({ run }: { run: RunDetail }): ReactNode {
  if (run.hidden || !run.settings.unmatchedRecords) return null;
  const parts = Object.entries(run.settings.unmatchedRecords)
    .filter((entry): entry is [keyof typeof RECORD_KIND_TEXT, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map(([kind, n]) => `${formatCount(n)} ${RECORD_KIND_TEXT[kind].toLowerCase()}`);
  if (parts.length === 0) return null;
  return (
    <p className="text-muted-foreground border-t pt-3 text-xs leading-relaxed">
      Records in the org that couldn’t be matched to the answer key, and so weren’t scored: {parts.join(', ')}.
    </p>
  );
}

export function ExtractionTile({ run }: { run: RunDetail }) {
  if (!run.parts.includes('extraction')) return null;
  const ratios = summaryGroup(run.summary, 'extraction', 'pipeline')?.ratios ?? null;
  return (
    <Tile id="extraction" title="Extraction" bodyClassName="grid content-start gap-4">
      {!run.summary ? (
        <NoScoresYet run={run} />
      ) : !ratios ? (
        <TileEmpty icon={Workflow}>No extraction item was scored.</TileEmpty>
      ) : (
        <>
          <ul className="grid gap-4">
            {EXTRACTION_RATIO_METRICS.map((name) => {
              const m = BENCHMARK_METRIC_BY_NAME[name];
              const r = ratios[name];
              return (
                <Ratio
                  key={name}
                  label={m.label}
                  definition={m.definition}
                  value={r.value}
                  numerator={r.numerator}
                  denominator={r.denominator}
                />
              );
            })}
          </ul>
          <Unmatched run={run} />
        </>
      )}
    </Tile>
  );
}
