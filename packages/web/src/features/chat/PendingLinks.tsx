// "Not reviewed yet" under an answer (D260): the pending link findings the API listed with the
// message, for the roles that can open the review queue (the API sends null for the others, and
// reads each finding again with the reader's access now, D50, D51). Each row is the link as the
// review queue shows it (its two ends, the link type in words), the sentence the AI read it from,
// its document and a way to its finding page; a finding decided since shows its status. The part
// sits in its own dashed, muted panel so it never reads as part of the answer: these are not facts
// yet. Nothing shows while the answer is being written; the list comes with the saved message.
import { BookOpenText, ChevronRight, CircleDashed, ListFilter } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { KIND_TEXT } from '@/features/intake/permissions';
import { FindingStatusBadge, LinkEndText, LinkPhrase } from '@/features/review/ReviewBits';
import { textOrNull } from '@/features/review/words';
import type { VisibleMessage } from './useChat';

export type PendingLinkList = NonNullable<VisibleMessage['pendingLinks']>;
export type PendingLinkItem = PendingLinkList['items'][number];

export const PENDING_LINKS_TEXT = {
  heading: 'Not reviewed yet',
  note: 'Possible links the AI found in your documents. An Analyst hasn’t checked them, so they aren’t facts yet.',
  open: 'Open in review',
  queue: 'Open the review queue',
} as const;

/** "Showing N of M." when the API listed fewer findings than it found, otherwise null. */
export function shownOfText(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total}.` : null;
}

function PendingLinkRow({ item }: { item: PendingLinkItem }) {
  const phraseId = useId();
  const sentence = textOrNull(item.sentence);
  return (
    <li className="grid gap-2 px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p id={phraseId} className="min-w-0 text-[13px] leading-snug">
          <LinkPhrase from={<LinkEndText end={item.from} />} type={item.type} to={<LinkEndText end={item.to} />} />
        </p>
        {item.status !== 'pending' ? <FindingStatusBadge status={item.status} className="mt-px shrink-0" /> : null}
      </div>
      {sentence !== null ? (
        <blockquote className="border-l-2 border-[#d9cfb3] py-0.5 pl-2.5 font-serif text-[13px] leading-[1.6] text-[#3a3f43] [overflow-wrap:anywhere]">
          “{sentence}”
        </blockquote>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {item.document !== null ? (
          <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <BookOpenText className="size-3.5 shrink-0 text-[#8c7333]" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-foreground font-medium">{item.document.name}</span>{' '}
              <span className="whitespace-nowrap">({KIND_TEXT[item.document.kind]})</span>
            </span>
          </p>
        ) : (
          <span aria-hidden />
        )}
        <Link
          to="/review/$id"
          params={{ id: item.findingId }}
          aria-describedby={phraseId}
          className="text-primary focus-visible:ring-ring inline-flex shrink-0 items-center gap-0.5 rounded-sm text-xs font-semibold underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {PENDING_LINKS_TEXT.open}
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}

/** The "Not reviewed yet" part, or nothing when the message has no pending links to show. */
export function PendingLinks({ pendingLinks }: { pendingLinks: PendingLinkList | null }) {
  const headingId = useId();
  if (pendingLinks === null || pendingLinks.items.length === 0) return null;
  const { items, total, documentId } = pendingLinks;
  const shownOf = shownOfText(items.length, total);
  return (
    <section
      aria-labelledby={headingId}
      className="bg-muted/50 grid gap-0 overflow-hidden rounded-md border border-dashed border-[#c3cbcf]"
    >
      <header className="grid gap-0.5 border-b border-dashed border-[#c3cbcf] px-3 py-2.5">
        <h3 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold">
          <CircleDashed className="size-3.5 shrink-0 text-[#b7791f]" aria-hidden />
          {PENDING_LINKS_TEXT.heading}
        </h3>
        <p className="text-muted-foreground text-xs leading-snug">{PENDING_LINKS_TEXT.note}</p>
      </header>
      <ul className="divide-y divide-dashed divide-[#d5dbde]">
        {items.map((item) => (
          <PendingLinkRow key={item.findingId} item={item} />
        ))}
      </ul>
      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-dashed border-[#c3cbcf] px-3 py-2">
        {shownOf !== null ? <p className="text-muted-foreground text-xs tabular-nums">{shownOf}</p> : <span />}
        <Link
          to="/review"
          search={documentId !== null ? { documentId } : {}}
          className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-xs font-semibold underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          <ListFilter className="size-3.5" aria-hidden />
          {PENDING_LINKS_TEXT.queue}
        </Link>
      </footer>
    </section>
  );
}
