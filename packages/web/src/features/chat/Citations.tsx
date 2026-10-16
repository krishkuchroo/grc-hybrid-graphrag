// An answer's citations (S6-007 behaviour 5 and 6): the chips in the answer's text and the Sources
// list under it. Each citation is what the API read again with the reader's access now (D51):
// - a record: its number, name and kind, linking to its page where its kind has one (evidence is
//   shown on its control's page, so it has none);
// - a passage: its document's name and kind and the passage's own words, set in the reading face the
//   review screen uses for documents, with a link to the document in Data intake only for the roles
//   with the uploads cell (D50);
// - one the reader can no longer see: plain text, nothing more.
// Graph records are teal and document passages parchment, so the two kinds of source read apart.
import { can, CHAT_TEXT, DOCUMENT_RECORD_TYPE, isUploadKind } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { BookOpenText, ChevronRight, EyeOff, Inbox } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KIND_TEXT } from '@/features/intake/permissions';
import { cn } from '@/lib/utils';
import type { MessageCitation, PassageCitation, RecordCitation } from './useChat';
import { hasPage, RECORD_KIND_ICON, RECORD_KIND_TEXT, RECORD_PAGE } from './words';

const CHIP_BASE =
  'mx-px inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-[4px] border px-1 align-[0.12em] text-[11px] leading-none font-bold tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const RECORD_CHIP = 'border-[#b5d1d4] bg-[#e6f1f2] text-primary hover:border-primary hover:bg-primary hover:text-white';
const PASSAGE_CHIP =
  'border-[#ddd2b4] bg-[#f6f1e3] text-[#6a5420] hover:border-[#8c7333] hover:bg-[#8c7333] hover:text-white data-[state=open]:border-[#8c7333] data-[state=open]:bg-[#8c7333] data-[state=open]:text-white';

/** Whether the person's role may open Data intake for this kind of document. */
export function canOpenInIntake(role: string | undefined, kind: string): boolean {
  if (role === undefined || !isUploadKind(kind)) return false;
  return can(role, 'uploads', 'use') && can(role, DOCUMENT_RECORD_TYPE[kind], 'view');
}

function recordLabel(c: RecordCitation): string {
  return `Source ${c.number}: ${RECORD_KIND_TEXT[c.record.kind]} ${c.record.number}, ${c.record.name}`;
}

function passageLabel(c: PassageCitation): string {
  return `Source ${c.number}: a passage of ${c.passage.documentName}`;
}

/** The passage's own words, its document, and where to find the document. */
export function PassageCard({
  citation,
  role,
  showDocument = true,
}: {
  citation: PassageCitation;
  role: string | undefined;
  /** False where the document's name and kind are already shown beside it. */
  showDocument?: boolean;
}) {
  const { passage } = citation;
  return (
    <div className="grid gap-3">
      {showDocument ? (
        <div className="flex min-w-0 items-start gap-2.5">
          <BookOpenText className="mt-0.5 size-4 shrink-0 text-[#8c7333]" aria-hidden />
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]">{passage.documentName}</p>
            <p className="text-muted-foreground text-xs">
              {KIND_TEXT[passage.documentKind]}, passage {passage.position + 1}
            </p>
          </div>
        </div>
      ) : null}
      <blockquote className="max-h-60 overflow-y-auto rounded-md border border-[#e4dfd2] bg-[#fbfaf6] px-3.5 py-2.5 font-serif text-[13.5px] leading-[1.65] whitespace-pre-wrap text-[#2a2f33]">
        {passage.text}
      </blockquote>
      {canOpenInIntake(role, passage.documentKind) && isUploadKind(passage.documentKind) ? (
        <Link
          to="/intake"
          search={{ q: passage.documentName, kind: passage.documentKind }}
          className="text-primary inline-flex items-center gap-1.5 justify-self-start text-xs font-semibold underline-offset-2 hover:underline"
        >
          <Inbox className="size-3.5" aria-hidden />
          Show the document in Data intake
        </Link>
      ) : null}
    </div>
  );
}

function RecordCard({ citation }: { citation: RecordCitation }) {
  const { record } = citation;
  const Icon = RECORD_KIND_ICON[record.kind];
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm leading-snug [overflow-wrap:anywhere]">
          <span className="font-semibold tabular-nums">{record.number}</span> {record.name}
        </p>
        <p className="text-muted-foreground text-xs">{RECORD_KIND_TEXT[record.kind]}</p>
      </div>
    </div>
  );
}

/** One citation inside the answer's text. */
export function CitationChip({ citation, role }: { citation: MessageCitation; role: string | undefined }) {
  if (citation.type === 'hidden') {
    return (
      <span className="text-muted-foreground mx-px align-[0.12em] text-[11px] font-semibold tabular-nums">
        [{citation.number}]<span className="sr-only"> {CHAT_TEXT.sourceHidden}</span>
      </span>
    );
  }

  if (citation.type === 'record') {
    const { record } = citation;
    if (hasPage(record.kind)) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={RECORD_PAGE[record.kind]}
              params={{ id: record.id }}
              aria-label={recordLabel(citation)}
              className={cn(CHIP_BASE, RECORD_CHIP)}
            >
              {citation.number}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top" className="grid gap-0.5">
            <span>
              <span className="font-bold text-white tabular-nums">{record.number}</span>{' '}
              <span className="text-chrome-muted">{RECORD_KIND_TEXT[record.kind]}</span>
            </span>
            <span className="text-white">{record.name}</span>
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Popover>
        <PopoverTrigger aria-label={recordLabel(citation)} className={cn(CHIP_BASE, RECORD_CHIP)}>
          {citation.number}
        </PopoverTrigger>
        <PopoverContent side="top" className="w-72">
          <RecordCard citation={citation} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover>
      <PopoverTrigger aria-label={passageLabel(citation)} className={cn(CHIP_BASE, PASSAGE_CHIP)}>
        {citation.number}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[22rem]">
        <PassageCard citation={citation} role={role} />
      </PopoverContent>
    </Popover>
  );
}

/** The number at the start of a Sources row, in the same colours as its chip. */
function SourceNumber({ citation }: { citation: MessageCitation }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[4px] border px-1 text-[11px] font-bold tabular-nums',
        citation.type === 'record' && 'border-[#b5d1d4] bg-[#e6f1f2] text-primary',
        citation.type === 'passage' && 'border-[#ddd2b4] bg-[#f6f1e3] text-[#6a5420]',
        citation.type === 'hidden' && 'border-border bg-muted text-muted-foreground',
      )}
    >
      {citation.number}
    </span>
  );
}

function RecordSourceRow({ citation }: { citation: RecordCitation }) {
  const { record } = citation;
  const Icon = RECORD_KIND_ICON[record.kind];
  const number = <span className="font-semibold whitespace-nowrap tabular-nums">{record.number}</span>;
  return (
    <div className="flex min-w-0 items-start gap-2 py-1.5">
      <SourceNumber citation={citation} />
      <span className="sr-only">Source {citation.number}:</span>
      <Icon className="text-primary mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-[13px] leading-snug [overflow-wrap:anywhere]">
        {hasPage(record.kind) ? (
          <Link
            to={RECORD_PAGE[record.kind]}
            params={{ id: record.id }}
            className="text-primary font-semibold whitespace-nowrap tabular-nums underline-offset-2 hover:underline"
          >
            {record.number}
          </Link>
        ) : (
          number
        )}{' '}
        <span>{record.name}</span>
      </span>
      <span className="text-muted-foreground mt-px shrink-0 text-xs">{RECORD_KIND_TEXT[record.kind]}</span>
    </div>
  );
}

function PassageSourceRow({ citation, role }: { citation: PassageCitation; role: string | undefined }) {
  const { passage } = citation;
  return (
    <Collapsible className="group/passage">
      <div className="flex min-w-0 items-start gap-2 py-1.5">
        <SourceNumber citation={citation} />
        <span className="sr-only">Source {citation.number}:</span>
        <BookOpenText className="mt-0.5 size-3.5 shrink-0 text-[#8c7333]" aria-hidden />
        <CollapsibleTrigger className="hover:text-primary focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left text-[13px] leading-snug focus-visible:ring-2 focus-visible:outline-none">
          <span className="font-semibold [overflow-wrap:anywhere]">{passage.documentName}</span>
          <ChevronRight
            className="text-muted-foreground ml-1 inline size-3.5 align-[-2px] transition-transform group-data-[state=open]/passage:rotate-90"
            aria-hidden
          />
          <span className="sr-only">, show the passage</span>
        </CollapsibleTrigger>
        <span className="text-muted-foreground mt-px shrink-0 text-xs">{KIND_TEXT[passage.documentKind]}</span>
      </div>
      <CollapsibleContent className="pb-2 pl-7">
        <PassageCard citation={citation} role={role} showDocument={false} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Every source the answer cites, by number. */
export function SourcesList({ citations, role }: { citations: MessageCitation[]; role: string | undefined }) {
  if (citations.length === 0) return null;
  const ordered = [...citations].sort((a, b) => a.number - b.number);
  return (
    <section aria-label="Sources" className="grid gap-0.5">
      <h3 className="text-muted-foreground text-xs font-semibold">Sources</h3>
      <ol className="divide-border/70 divide-y">
        {ordered.map((citation) => (
          <li key={citation.number}>
            {citation.type === 'record' ? (
              <RecordSourceRow citation={citation} />
            ) : citation.type === 'passage' ? (
              <PassageSourceRow citation={citation} role={role} />
            ) : (
              <div className="text-muted-foreground flex items-center gap-2 py-1.5 text-[13px]">
                <SourceNumber citation={citation} />
                <EyeOff className="size-3.5 shrink-0" aria-hidden />
                <span>{CHAT_TEXT.sourceHidden}</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
