// A run's verdict (S8-010, D1: prove hybrid beats plain vector search), the first thing its page
// shows: how many of the scores hybrid won, then the two headline scores, context recall and answer
// correctness, each as the two modes' numbers side by side, the gap between them on a 0 to 100%
// track, and the result in a sentence. The numbers are the API's summary (`summariseBenchmark`).
import {
  BENCHMARK_METRIC_BY_NAME,
  BENCHMARK_QUESTION_PARTS,
  BENCHMARK_SCORE_METRICS,
  metricAppliesTo,
  summaryGroup,
  type BenchmarkQuestionPart,
  type BenchmarkSummary,
} from '@grc/shared';
import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DiffPill, ModeSwatch } from './BenchmarkBits';
import type { RunDetail } from './useBenchmark';
import { MODE_COLOR, percentText, scoreDiff, type DiffTone } from './words';

const GAP_COLOR: Record<DiffTone, string> = {
  better: '#2f8a55',
  worse: '#b42318',
  even: '#8a969c',
  none: '#8a969c',
};

interface HeadlineScore {
  part: BenchmarkQuestionPart;
  metric: 'context_recall' | 'answer_correctness';
  hybrid: number | null;
  vector: number | null;
}

/** "Hybrid search put 86% of the expected records in the context; vector-only search put 54%." */
function headlineSentence(score: HeadlineScore): string {
  const h = percentText(score.hybrid);
  const v = percentText(score.vector);
  if (score.metric === 'context_recall') {
    return `Hybrid search put ${h} of the expected records in the answer’s context; vector-only search put ${v}.`;
  }
  return `Hybrid answers named ${h} of the expected records; vector-only answers named ${v}.`;
}

/** The two modes on one 0 to 100% track, joined by the gap between them. */
function GapTrack({ score }: { score: HeadlineScore }) {
  const h = Math.min(1, Math.max(0, score.hybrid ?? 0)) * 100;
  const v = Math.min(1, Math.max(0, score.vector ?? 0)) * 100;
  const tone = scoreDiff(score.metric, score.hybrid, score.vector).tone;
  const from = Math.min(h, v);
  return (
    <div aria-hidden className="grid gap-1">
      <div className="relative h-6">
        <div className="bg-muted absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" />
        {[25, 50, 75].map((at) => (
          <span key={at} className="bg-border absolute top-1/2 h-3 w-px -translate-y-1/2" style={{ left: `${at}%` }} />
        ))}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
          style={{ left: `${from}%`, width: `${Math.abs(h - v)}%`, backgroundColor: GAP_COLOR[tone] }}
        />
        {score.vector !== null ? (
          <span
            className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm"
            style={{ left: `${v}%`, backgroundColor: MODE_COLOR.vector }}
          />
        ) : null}
        {score.hybrid !== null ? (
          <span
            className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm"
            style={{ left: `${h}%`, backgroundColor: MODE_COLOR.hybrid }}
          />
        ) : null}
      </div>
      <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  );
}

function Figure({ mode, value }: { mode: 'hybrid' | 'vector'; value: number | null }) {
  return (
    <div className="grid gap-1">
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-semibold">
        <ModeSwatch mode={mode} />
        {mode === 'hybrid' ? 'Hybrid' : 'Vector only'}
      </span>
      <span
        className={cn(
          'text-[2.5rem] leading-none font-bold tracking-tight tabular-nums',
          mode === 'hybrid' ? 'text-primary' : 'text-[#5e717c]',
        )}
      >
        {percentText(value)}
      </span>
    </div>
  );
}

function HeadlinePanel({ score, waiting }: { score: HeadlineScore; waiting: boolean }) {
  const metric = BENCHMARK_METRIC_BY_NAME[score.metric];
  const id = `verdict-${score.metric}`;
  const measured = score.hybrid !== null || score.vector !== null;
  return (
    <section aria-labelledby={id} className="grid content-start gap-4 px-6 py-5">
      <header className="flex items-start gap-3">
        <div className="grid gap-0.5">
          <h3 id={id} className="text-sm font-semibold">
            {metric.label}
          </h3>
          <p className="text-muted-foreground max-w-[60ch] text-xs leading-relaxed">{metric.definition}</p>
        </div>
        {measured ? (
          <DiffPill diff={scoreDiff(score.metric, score.hybrid, score.vector)} className="ml-auto text-sm" />
        ) : null}
      </header>
      {measured ? (
        <>
          <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
            <Figure mode="hybrid" value={score.hybrid} />
            <Figure mode="vector" value={score.vector} />
          </div>
          <GapTrack score={score} />
          <p className="text-sm leading-relaxed">{headlineSentence(score)}</p>
        </>
      ) : (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Hourglass className="size-4 shrink-0" aria-hidden />
          {waiting ? 'The score appears when the run finishes.' : 'No question was scored on this.'}
        </p>
      )}
    </section>
  );
}

/** How hybrid did on every score both modes measured: better, worse or the same. */
function tally(summary: BenchmarkSummary | null) {
  let better = 0;
  let worse = 0;
  let even = 0;
  for (const part of BENCHMARK_QUESTION_PARTS) {
    const hybrid = summaryGroup(summary, part, 'hybrid');
    const vector = summaryGroup(summary, part, 'vector');
    if (!hybrid || !vector) continue;
    for (const metric of BENCHMARK_SCORE_METRICS) {
      if (!metricAppliesTo(metric, part, 'hybrid', null) || !metricAppliesTo(metric, part, 'vector', null)) continue;
      const tone = scoreDiff(metric, hybrid.scores[metric]?.mean ?? null, vector.scores[metric]?.mean ?? null).tone;
      if (tone === 'better') better += 1;
      else if (tone === 'worse') worse += 1;
      else if (tone === 'even') even += 1;
    }
  }
  return { better, worse, even, compared: better + worse + even };
}

function leadText(summary: BenchmarkSummary | null, running: boolean): string {
  if (!summary) {
    return running
      ? 'The scores appear when the run finishes; the results below fill in as it goes.'
      : 'This run has no summary.';
  }
  const t = tally(summary);
  if (t.compared === 0) return 'This run has no score both modes measured, so there is nothing to compare.';
  const rest = [t.worse > 0 ? `worse on ${t.worse}` : null, t.even > 0 ? `the same on ${t.even}` : null].filter(
    (part): part is string => part !== null,
  );
  return `Hybrid did better on ${t.better} of ${t.compared} scores${rest.length > 0 ? `, ${rest.join(' and ')}` : ''}.`;
}

export function Verdict({ run }: { run: RunDetail }) {
  const scores: HeadlineScore[] = [];
  if (run.parts.includes('retrieval')) {
    scores.push({
      part: 'retrieval',
      metric: 'context_recall',
      hybrid: run.headline.hybrid.contextRecall,
      vector: run.headline.vector.contextRecall,
    });
  }
  if (run.parts.includes('answers')) {
    scores.push({
      part: 'answers',
      metric: 'answer_correctness',
      hybrid: run.headline.hybrid.answerCorrectness,
      vector: run.headline.vector.answerCorrectness,
    });
  }
  const bothModes = run.modes.includes('hybrid') && run.modes.includes('vector');
  if (scores.length === 0) return null;

  return (
    <section aria-labelledby="verdict" className="bg-card min-w-0 rounded-lg border shadow-xs">
      <header className="grid gap-1 border-b px-6 py-4">
        <h2 id="verdict" className="text-base font-semibold">
          Hybrid against vector only
        </h2>
        <p className="text-sm">
          {bothModes ? leadText(run.summary, run.status === 'running') : 'This run measured only one mode.'}
        </p>
      </header>
      <div className={cn('grid divide-y', scores.length > 1 && 'lg:grid-cols-2 lg:divide-x lg:divide-y-0')}>
        {scores.map((score) => (
          <HeadlinePanel key={score.metric} score={score} waiting={run.status === 'running'} />
        ))}
      </div>
    </section>
  );
}
