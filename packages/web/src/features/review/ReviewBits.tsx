// The small pieces the Analyst review screens share (D2, the S1 records kit's look): a finding's
// status and kind, a failed check, a record a finding names (by number, linking to its page, or
// "A record you can't see"), a link end, a link read as plain words, and the panel frame.
import { reviewKindText, reviewStatusText, ruleCheckText, type ReviewFindingKind } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  CircleAlert,
  Copy,
  EyeOff,
  FilePlus2,
  Link2,
  Network,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { LinkEndRow } from './useReview';
import { HIDDEN_RECORD_TEXT, linkTypeText, RECORD_KIND_TEXT } from './words';

export const KIND_ICON: Readonly<Record<ReviewFindingKind, LucideIcon>> = {
  link: Link2,
  record: FilePlus2,
  duplicate: Copy,
  mapping: Network,
};

type Tone = 'amber' | 'green' | 'teal' | 'grey' | 'red';

const STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  live: 'green',
  approved: 'teal',
  rejected: 'grey',
  removed: 'red',
};

const BADGE: Record<Tone, string> = {
  amber: 'border-[#e3c98f] bg-[#fdf6e5] text-[#7a5410]',
  green: 'border-[#9fcdb1] bg-[#e4f2e9] text-[#1f5c38]',
  teal: 'border-[#9cc4d0] bg-[#eaf4f7] text-[#12404d]',
  grey: 'border-border bg-muted text-muted-foreground',
  red: 'border-[#e2b0ab] bg-[#fcefed] text-[#8f1f15]',
};

const DOT: Record<Tone, string> = {
  amber: 'bg-[#d4a017]',
  green: 'bg-[#2f8a55]',
  teal: 'bg-[#1b8a94]',
  grey: 'bg-[#8a969c]',
  red: 'bg-[#b42318]',
};

/** A finding's status as a ServiceNow state badge: Waiting, Live, Approved, Rejected or Removed. */
export function FindingStatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONE[status] ?? 'grey';
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap',
        BADGE[tone],
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} aria-hidden />
      {reviewStatusText(status)}
    </span>
  );
}

/** A finding's kind, with its icon. */
export function KindBadge({ kind, className }: { kind: ReviewFindingKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn(
        'border-border bg-card text-foreground inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap',
        className,
      )}
    >
      <Icon className="text-primary size-3" aria-hidden />
      {reviewKindText(kind)}
    </span>
  );
}

/** A rule check a link failed, in S5-001's plain words. */
export function FailedCheckBadge({ check }: { check: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-[#e7c7a1] bg-[#fdf3e7] px-1.5 py-0.5 text-xs leading-snug font-semibold text-[#7a3f0a]">
      <CircleAlert className="size-3 shrink-0" aria-hidden />
      {ruleCheckText(check)}
    </span>
  );
}

/** "AI" beside something the extraction wrote: Gemma's words, not a record's. */
export function AiMark({ className }: { className?: string }) {
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-0.5 text-[11px] font-semibold', className)}>
      <Sparkles className="size-3" aria-hidden />
      AI
    </span>
  );
}

/** Each kind's record page. */
export const RECORD_PAGE = {
  risk: '/risks/$id',
  control: '/controls/$id',
  policy: '/policies/$id',
  asset: '/assets/$id',
  incident: '/incidents/$id',
  requirement: '/requirements/$id',
} as const;

export type PageKind = keyof typeof RECORD_PAGE;

export function isPageKind(kind: string): kind is PageKind {
  return Object.hasOwn(RECORD_PAGE, kind);
}

/** A record's number, linking to its page. */
export function RecordLink({
  kind,
  id,
  number,
  className,
}: {
  kind: string;
  id: string;
  number: string;
  className?: string;
}) {
  if (!isPageKind(kind)) return <span className={cn('font-semibold tabular-nums', className)}>{number}</span>;
  return (
    <Link
      to={RECORD_PAGE[kind]}
      params={{ id }}
      className={cn('text-primary font-semibold tabular-nums underline-offset-2 hover:underline', className)}
    >
      {number}
    </Link>
  );
}

/** A record a finding names, as the reader may see it. */
export type NamedRecord = { recordId: string; number: string; name: string; kind: string } | { hidden: true };

export function isShown(record: NamedRecord): record is Extract<NamedRecord, { recordId: string }> {
  return !('hidden' in record);
}

/** "A record you can't see", the same for every cause. */
export function HiddenRecord({ className }: { className?: string }) {
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1.5 italic', className)}>
      <EyeOff className="size-3.5 shrink-0" aria-hidden />
      {HIDDEN_RECORD_TEXT}
    </span>
  );
}

/** A named record: its number linking to its page and its name, or "A record you can't see".
 * `plain` shows the number without a link (inside another link, a list row's). */
export function NamedRecordText({
  record,
  plain = false,
  className,
}: {
  record: NamedRecord;
  plain?: boolean;
  className?: string;
}) {
  if (!isShown(record)) return <HiddenRecord className={className} />;
  return (
    <span className={cn('min-w-0 [overflow-wrap:anywhere]', className)}>
      {plain ? (
        <span className="font-semibold whitespace-nowrap tabular-nums">{record.number}</span>
      ) : (
        <RecordLink kind={record.kind} id={record.recordId} number={record.number} className="whitespace-nowrap" />
      )}{' '}
      <span>{record.name}</span>
    </span>
  );
}

/** One end of a link in a list row: its record, or Gemma's name with what it waits on. */
export function LinkEndText({ end }: { end: LinkEndRow }) {
  switch (end.state) {
    case 'matched':
      return <NamedRecordText record={end.record} plain />;
    case 'hidden':
      return <HiddenRecord />;
    case 'candidates':
      return (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="font-semibold [overflow-wrap:anywhere]">“{end.name}”</span>
          <span className="text-muted-foreground text-xs whitespace-nowrap">
            {end.candidateCount === 0
              ? `no ${RECORD_KIND_TEXT[end.kind].toLowerCase()} found`
              : `${end.candidateCount} possible ${end.candidateCount === 1 ? 'match' : 'matches'}`}
          </span>
        </span>
      );
    case 'proposed':
      return (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="font-semibold [overflow-wrap:anywhere]">“{end.name}”</span>
          <span className="text-muted-foreground text-xs whitespace-nowrap">
            proposed new {RECORD_KIND_TEXT[end.kind].toLowerCase()}
          </span>
        </span>
      );
  }
}

/** A link or mapping read as plain words: `srv-pay-01 → exposed to → SQL injection`. When it
 * wraps, the link type stays with the end it points to. */
export function LinkPhrase({ from, type, to }: { from: ReactNode; type: string; to: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="min-w-0">{from}</span>
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-primary inline-flex shrink-0 items-center gap-1 self-center text-xs font-semibold whitespace-nowrap">
          <ArrowRight className="size-3" aria-hidden />
          {linkTypeText(type)}
          <ArrowRight className="size-3" aria-hidden />
        </span>
        <span className="min-w-0">{to}</span>
      </span>
    </span>
  );
}

/** A titled panel, as on the record pages. */
export function Panel({
  title,
  icon: Icon,
  toolbar,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn('bg-card rounded-lg border shadow-xs', className)}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {Icon ? <Icon className="text-primary size-4" aria-hidden /> : null}
          {title}
        </h2>
        {toolbar ? <div className="ml-auto flex items-center gap-2">{toolbar}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface SheetItem {
  label: string;
  value: ReactNode;
  wide?: boolean;
}

/** Label-and-value pairs in two columns, as on the record pages. */
export function Sheet({ items, className }: { items: SheetItem[]; className?: string }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className={cn('grid min-w-0 gap-1', item.wide && 'sm:col-span-2')}>
          <dt className="text-muted-foreground text-xs font-semibold">{item.label}</dt>{' '}
          <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
