// The small pieces the Benchmark screens share (S8-010), in the app's ServiceNow look (D2): a run's
// status, an item's outcome, a D48 target's pass or fail, the difference between the modes, the
// two modes' legend, a record number that opens its page, the commands of the empty state, the
// progress of a running run and the no-access screen.
import {
  BENCHMARK_TEXT,
  benchmarkNoProgressText,
  benchmarkOutcomeText,
  benchmarkRunningText,
  benchmarkStatusText,
} from '@grc/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, EyeOff, Lock, LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RECORD_PAGE } from '@/features/chat/words';
import { formatRole } from '@/features/auth/session';
import { formatMoment } from '@/features/records/format';
import { cn } from '@/lib/utils';
import { isOpenableKind, recordIdQuery, type RunRow } from './useBenchmark';
import { MODE_COLOR, type DiffTone, type QuestionMode, type ScoreDiff } from './words';

type Tone = 'blue' | 'green' | 'amber' | 'red' | 'grey';

const BADGE: Record<Tone, string> = {
  blue: 'border-[#a9c6e4] bg-[#edf4fb] text-[#1d4f86]',
  green: 'border-[#9fcdb1] bg-[#e4f2e9] text-[#1f5c38]',
  amber: 'border-[#e3c98f] bg-[#fdf6e5] text-[#7a5410]',
  red: 'border-[#e2b0ab] bg-[#fcefed] text-[#8f1f15]',
  grey: 'border-border bg-muted text-muted-foreground',
};

const DOT: Record<Tone, string> = {
  blue: 'bg-[#2b6cb0]',
  green: 'bg-[#2f8a55]',
  amber: 'bg-[#d4a017]',
  red: 'bg-[#b42318]',
  grey: 'bg-[#8a969c]',
};

function Badge({
  tone,
  pulse,
  children,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap',
        BADGE[tone],
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse')} aria-hidden />
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = { running: 'blue', finished: 'green', failed: 'red' };

/** A run's status: Running, Finished or Failed. */
export function RunStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'grey'} pulse={status === 'running'}>
      {benchmarkStatusText(status)}
    </Badge>
  );
}

const OUTCOME_TONE: Record<string, Tone> = { pass: 'green', partial: 'amber', fail: 'red', skipped: 'grey' };

/** An item's outcome: Pass, Partial, Fail or Skipped. */
export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={OUTCOME_TONE[outcome] ?? 'grey'}>{benchmarkOutcomeText(outcome)}</Badge>;
}

/** A D48 target's result at the 95th percentile: Pass, Fail, or No data. */
export function TargetBadge({ pass }: { pass: boolean | null }) {
  if (pass === null) return <Badge tone="grey">No data</Badge>;
  return <Badge tone={pass ? 'green' : 'red'}>{pass ? 'Pass' : 'Fail'}</Badge>;
}

const DIFF_TONE: Record<DiffTone, string> = {
  better: 'border-[#9fcdb1] bg-[#e4f2e9] text-[#1f5c38]',
  worse: 'border-[#e2b0ab] bg-[#fcefed] text-[#8f1f15]',
  even: 'border-border bg-muted text-muted-foreground',
  none: 'border-transparent bg-transparent text-muted-foreground',
};

/** The difference between hybrid and vector only on one metric, green when it favours hybrid. */
export function DiffPill({ diff, className }: { diff: ScoreDiff; className?: string }) {
  return (
    <span
      title={diff.sentence}
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs leading-none font-bold whitespace-nowrap tabular-nums',
        DIFF_TONE[diff.tone],
        className,
      )}
    >
      <span aria-hidden>{diff.text}</span>
      <span className="sr-only">{diff.sentence}</span>
    </span>
  );
}

/** A mode's colour swatch. */
export function ModeSwatch({ mode, className }: { mode: QuestionMode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', className)}
      style={{ backgroundColor: MODE_COLOR[mode] }}
    />
  );
}

/** Which colour is which mode. */
export function ModeLegend({ className }: { className?: string }) {
  return (
    <span className={cn('text-muted-foreground inline-flex flex-wrap items-center gap-x-4 gap-y-1 text-xs', className)}>
      <span className="inline-flex items-center gap-1.5">
        <ModeSwatch mode="hybrid" />
        <span className="text-foreground font-semibold">Hybrid</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ModeSwatch mode="vector" />
        <span className="text-foreground font-semibold">Vector only</span>
      </span>
    </span>
  );
}

const NOT_FOUND = "This record doesn't exist or you can't see it.";

/**
 * A record number. For a kind with a page it opens that page: the number is looked up in its kind's
 * list as the person (results hold numbers, not IDs), and one that is missing or hidden from them
 * says so in place. Evidence and unknown kinds read as plain text.
 */
export function RecordNumber({ kind, number, className }: { kind: string; number: string; className?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<'idle' | 'opening' | 'missing' | 'failed'>('idle');

  if (!isOpenableKind(kind)) {
    return <span className={cn('font-semibold whitespace-nowrap tabular-nums', className)}>{number}</span>;
  }
  const open = async () => {
    setState('opening');
    try {
      const id = await queryClient.fetchQuery(recordIdQuery(kind, number));
      if (id === null) {
        setState('missing');
        return;
      }
      setState('idle');
      await navigate({ to: RECORD_PAGE[kind], params: { id } });
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <button
        type="button"
        onClick={() => void open()}
        disabled={state === 'opening'}
        aria-label={`Open ${number}`}
        className={cn(
          'text-primary inline-flex items-center gap-1 rounded-sm font-semibold whitespace-nowrap tabular-nums underline-offset-2 hover:underline',
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] disabled:cursor-progress',
          className,
        )}
      >
        {number}
        {state === 'opening' ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : null}
      </button>
      {state === 'missing' || state === 'failed' ? (
        <span role="status" className="text-muted-foreground inline-flex items-center gap-1 text-xs italic">
          <EyeOff className="size-3 shrink-0" aria-hidden />
          {state === 'missing' ? NOT_FOUND : "The record couldn't be looked up. Try again."}
        </span>
      ) : null}
    </span>
  );
}

/** A command to run on the Mac, with a button that copies it. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="bg-chrome text-chrome-foreground flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] leading-relaxed whitespace-pre">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : `Copy the command ${command}`}
        className="hover:bg-chrome-raised text-chrome-muted grid size-7 shrink-0 place-items-center rounded transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
      >
        {copied ? <Check className="text-brand size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
    </div>
  );
}

/** The progress of a running run: "Running: N of M questions", its bar, and "No progress since …"
 * once it has gone 30 minutes without new results. */
export function RunProgress({
  run,
  progress,
  stalled,
  compact = false,
}: {
  run: RunRow;
  progress: { done: number; total: number } | null;
  stalled: boolean;
  compact?: boolean;
}) {
  if (run.status !== 'running' || !progress) return null;
  const share = progress.total === 0 ? 0 : Math.min(100, (progress.done / progress.total) * 100);
  return (
    <div className={cn('grid gap-1.5', compact ? 'min-w-[9rem]' : 'w-full')}>
      <p className={cn('tabular-nums', compact ? 'text-xs' : 'text-sm font-semibold')}>
        {progress.total > 0 ? benchmarkRunningText(progress.done, progress.total) : 'Running: measuring extraction'}
      </p>
      {progress.total > 0 ? (
        <div
          role="progressbar"
          aria-label="Questions done"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          className={cn('bg-muted w-full overflow-hidden rounded-full', compact ? 'h-1.5' : 'h-2')}
        >
          <span className="bg-primary block h-full rounded-full transition-[width]" style={{ width: `${share}%` }} />
        </div>
      ) : null}
      {stalled ? (
        <p className="text-xs font-semibold text-[#8f1f15]">
          {benchmarkNoProgressText(formatMoment(run.lastActivityAt))}
        </p>
      ) : null}
    </div>
  );
}

/** What a run above the reader's clearance shows instead of its questions and answers (D51). */
export function HiddenNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        'text-muted-foreground flex items-start gap-2.5 rounded-md border border-dashed px-4 py-3 text-sm',
        className,
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{BENCHMARK_TEXT.hidden}</p>
    </div>
  );
}

/** The screen for a role the benchmark isn't for. */
export function BenchmarkNoAccess({ role }: { role: string | undefined }) {
  return (
    <div className="px-8 py-8">
      <section
        aria-labelledby="benchmark-no-access"
        className="bg-card mx-auto flex max-w-xl flex-col items-center gap-3 rounded-lg border px-8 py-12 text-center shadow-xs"
      >
        <span className="bg-muted text-muted-foreground grid size-11 place-items-center rounded-full">
          <Lock className="size-5" aria-hidden />
        </span>
        <h2 id="benchmark-no-access" className="text-base font-semibold">
          You don’t have access to the benchmark
        </h2>
        <p className="text-muted-foreground text-sm">
          {role ? `As ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${formatRole(role)}, you` : 'You'} can’t see benchmark
          runs. Only your organisation’s Admins can, since a run’s questions and answers come from across its records.
        </p>
      </section>
    </div>
  );
}
