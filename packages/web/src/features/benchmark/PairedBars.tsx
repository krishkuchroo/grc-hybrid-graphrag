// Hybrid and vector only side by side on one score (S8-010): two short bars on a shared 0 to 100%
// scale, each with its value, and the difference called out. The runs list uses it for each run's
// headline numbers; the words carry the values, the bars repeat them.
import { cn } from '@/lib/utils';
import { DiffPill, ModeSwatch } from './BenchmarkBits';
import { formatScore, scoreDiff, type QuestionMode, MODE_COLOR } from './words';

function Bar({ mode, metric, value }: { mode: QuestionMode; metric: string; value: number | null }) {
  const width = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) * 100 : 0;
  return (
    <span className="grid grid-cols-[0.625rem_minmax(0,1fr)_2.5rem] items-center gap-1.5">
      <ModeSwatch mode={mode} />
      <span aria-hidden className="bg-muted block h-1.5 overflow-hidden rounded-full">
        <span className="block h-full rounded-full" style={{ width: `${width}%`, backgroundColor: MODE_COLOR[mode] }} />
      </span>
      <span className="text-right text-xs font-semibold tabular-nums">
        <span className="sr-only">{mode === 'hybrid' ? 'Hybrid' : 'Vector only'}: </span>
        {formatScore(metric, value)}
      </span>
    </span>
  );
}

export function PairedBars({
  metric,
  hybrid,
  vector,
  emptyText,
  className,
}: {
  metric: string;
  hybrid: number | null;
  vector: number | null;
  /** What to say when neither mode has a value. */
  emptyText: string;
  className?: string;
}) {
  if (hybrid === null && vector === null) {
    return <span className={cn('text-muted-foreground text-xs', className)}>{emptyText}</span>;
  }
  return (
    <span className={cn('grid w-[13.5rem] grid-cols-[minmax(0,1fr)_4.25rem] items-center gap-x-2.5', className)}>
      <span className="grid gap-1">
        <Bar mode="hybrid" metric={metric} value={hybrid} />
        <Bar mode="vector" metric={metric} value={vector} />
      </span>
      <DiffPill diff={scoreDiff(metric, hybrid, vector)} className="justify-self-start" />
    </span>
  );
}
