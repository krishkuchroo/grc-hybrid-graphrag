// A value from one of the S1-001 lists (a control's status, an incident's severity…) as a ServiceNow
// state indicator: a coloured dot beside the plain words. The colour says how urgent or settled the
// value is; the words carry the meaning, so colour is never the only cue.
import { cn } from '@/lib/utils';
import { words } from './format';

type Tone = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'grey';

const DOT: Record<Tone, string> = {
  red: 'bg-[#b42318]',
  orange: 'bg-[#dd6b20]',
  amber: 'bg-[#d4a017]',
  green: 'bg-[#2f8a55]',
  blue: 'bg-[#2b6cb0]',
  grey: 'bg-[#8a969c]',
};

const TONES: Record<string, Tone> = {
  // Severity and criticality.
  critical: 'red',
  high: 'orange',
  medium: 'amber',
  low: 'green',
  // A control's status.
  implemented: 'green',
  planned: 'blue',
  not_implemented: 'red',
  // An incident's status.
  new: 'blue',
  investigating: 'orange',
  contained: 'amber',
  resolved: 'green',
  closed: 'grey',
};

export function ValueBadge({ value, className }: { value: string; className?: string }) {
  const tone = TONES[value] ?? 'grey';
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden />
      <span>{words(value)}</span>
    </span>
  );
}
