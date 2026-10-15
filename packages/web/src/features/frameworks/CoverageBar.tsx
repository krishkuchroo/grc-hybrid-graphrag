// A framework's coverage for the signed-in person, as the API counted it (D51): one bar split into
// implemented, covered but not yet implemented, and not covered, beside the counts in words. A
// requirement is covered when an active control the person can see satisfies it, and implemented
// when one of those controls is implemented. The words carry the meaning; the bar repeats them.
import { cn } from '@/lib/utils';

const COUNT = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return COUNT.format(n);
}

export interface Coverage {
  /** Active requirements. */
  total: number;
  covered: number;
  implemented: number;
}

/** Counts that can be drawn: never negative, implemented within covered within the total. */
function normalise({ total, covered, implemented }: Coverage): Coverage {
  const t = Math.max(0, total);
  const c = Math.min(Math.max(0, covered), t);
  const i = Math.min(Math.max(0, implemented), c);
  return { total: t, covered: c, implemented: i };
}

/** The share covered, as a whole percent (0 when there is nothing to cover). */
export function coveredPercent(coverage: Coverage): number {
  const { total, covered } = normalise(coverage);
  return total === 0 ? 0 : Math.round((covered / total) * 100);
}

/** "412 of 1,007 requirements covered, 300 implemented". */
export function coverageSentence(coverage: Coverage): string {
  const { total, covered, implemented } = normalise(coverage);
  if (total === 0) return 'No active requirements to cover';
  const noun = total === 1 ? 'requirement' : 'requirements';
  return `${formatCount(covered)} of ${formatCount(total)} ${noun} covered, ${formatCount(implemented)} implemented`;
}

/** The three parts' colours, shared by the bar, its legend and the requirements table. */
export const COVERAGE_TONE = {
  implemented: 'bg-primary',
  covered: 'bg-[#7fbcc1]',
  uncovered: 'bg-[#e1e7ea]',
} as const;

export function CoverageBar({
  coverage,
  size = 'sm',
  className,
}: {
  coverage: Coverage;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const { total, covered, implemented } = normalise(coverage);
  const share = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div
      aria-hidden
      data-slot="coverage-bar"
      className={cn(
        'flex w-full overflow-hidden rounded-full',
        COVERAGE_TONE.uncovered,
        size === 'lg' ? 'h-3' : 'h-2',
        className,
      )}
    >
      <span className={cn('h-full', COVERAGE_TONE.implemented)} style={{ width: `${share(implemented)}%` }} />
      <span className={cn('h-full', COVERAGE_TONE.covered)} style={{ width: `${share(covered - implemented)}%` }} />
    </div>
  );
}

/** The legend under a large bar: each part with its count. */
export function CoverageLegend({ coverage, className }: { coverage: Coverage; className?: string }) {
  const { total, covered, implemented } = normalise(coverage);
  const parts = [
    { tone: COVERAGE_TONE.implemented, label: 'Implemented', count: implemented },
    { tone: COVERAGE_TONE.covered, label: 'Covered, not yet implemented', count: covered - implemented },
    { tone: COVERAGE_TONE.uncovered, label: 'Not covered', count: total - covered },
  ];
  return (
    <ul className={cn('flex flex-wrap gap-x-5 gap-y-1.5 text-xs', className)}>
      {parts.map((part) => (
        <li key={part.label} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-[3px] ring-1 ring-black/10 ring-inset', part.tone)} aria-hidden />
          <span className="text-muted-foreground">{part.label}</span>
          <span className="font-semibold tabular-nums">{formatCount(part.count)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One requirement's coverage, in the bar's colours: implemented, covered or not covered. */
export function CoverageState({ covered, implemented }: { covered: boolean; implemented: boolean }) {
  const state = implemented ? 'implemented' : covered ? 'covered' : 'uncovered';
  const label = implemented ? 'Implemented' : covered ? 'Covered' : 'Not covered';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          state === 'uncovered' ? 'border-muted-foreground/60 border bg-transparent' : COVERAGE_TONE[state],
        )}
      />
      <span className={cn(state === 'uncovered' && 'text-muted-foreground')}>{label}</span>
    </span>
  );
}
