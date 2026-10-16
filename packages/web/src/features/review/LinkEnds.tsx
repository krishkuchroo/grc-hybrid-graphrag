// A link finding's two ends, side by side with the link between them (S5-005): each end as Gemma
// named it and where it stands. A clear match shows its record (linking to its page); an uncertain
// end offers its candidates (number, name, how matching found it and the score), one of which the
// Analyst chooses; an end that is a proposed new record links to that finding with its status; a
// record the reader may not see reads "A record you can't see" (D51, D57). Choosing a candidate only
// fills in the approval; the API checks it is one of that end's candidates (D7).
import { isRecordKind } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowRight, CircleCheck, CircleHelp, FilePlus2, ListFilter, SearchX } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { AiMark, FindingStatusBadge, HiddenRecord, isShown, NamedRecordText, Panel } from './ReviewBits';
import type { LinkEnd, LinkFindingDetail, ReviewSearch } from './useReview';
import { linkTypeText, matchStepText, percent, RECORD_KIND_TEXT } from './words';

export type Side = 'from' | 'to';

/** The records the Analyst chose for the uncertain ends. */
export type EndChoice = Partial<Record<Side, string>>;

/**
 * Whether an end is settled for approving: `null` when it is (a clear match, a chosen candidate,
 * or a proposed record already approved), or why not, in plain words.
 */
export function endBlocker(end: LinkEnd, chosen: string | undefined): string | null {
  const noun = RECORD_KIND_TEXT[end.kind].toLowerCase();
  switch (end.state) {
    case 'matched':
      return null;
    case 'candidates': {
      if (end.candidates.length === 0)
        return `No ${noun} was found for “${end.name}”, so this link can only be rejected.`;
      const ok = chosen !== undefined && end.candidates.some((c) => isShown(c.record) && c.record.recordId === chosen);
      return ok ? null : `Choose which ${noun} “${end.name}” means.`;
    }
    case 'proposed':
      if (end.status === 'approved') return null;
      if (end.status === 'pending') return `Approve the proposed ${noun} “${end.name}” first.`;
      if (end.status === 'rejected') {
        return `The proposed ${noun} “${end.name}” was rejected, so this link can only be rejected.`;
      }
      return `The proposed ${noun} “${end.name}” was taken back out, so this link can only be rejected.`;
    case 'hidden':
      return 'One end is a record you can’t see, so you can’t approve this link.';
  }
}

/** The record the decision used for an end, from the outcome, to mark the chosen candidate. */
function decidedId(finding: LinkFindingDetail, side: Side): string | undefined {
  if (!finding.outcome) return undefined;
  return side === 'from' ? finding.outcome.fromId : finding.outcome.toId;
}

/** The queue narrowed to the findings that name this record. */
export function OtherFindingsLink({ recordId, kind }: { recordId: string; kind: string }) {
  const search: ReviewSearch = { recordId };
  if (isRecordKind(kind)) search.recordKind = kind;
  return (
    <Link
      to="/review"
      search={search}
      className="text-primary inline-flex items-center gap-1 text-xs font-semibold hover:underline"
    >
      <ListFilter className="size-3.5" aria-hidden />
      Other findings naming it
    </Link>
  );
}

function Candidates({
  end,
  side,
  chosen,
  decided,
  canChoose,
  onChoose,
}: {
  end: Extract<LinkEnd, { state: 'candidates' }>;
  side: Side;
  chosen: string | undefined;
  decided: string | undefined;
  canChoose: boolean;
  onChoose: (side: Side, recordId: string) => void;
}) {
  const groupId = useId();
  const noun = RECORD_KIND_TEXT[end.kind].toLowerCase();
  if (end.candidates.length === 0) {
    return (
      <p className="text-muted-foreground flex items-start gap-2 text-sm">
        <SearchX className="mt-0.5 size-4 shrink-0" aria-hidden />
        No {noun} close enough to “{end.name}” was found.
      </p>
    );
  }
  const items = end.candidates.map((candidate, i) => {
    const record = candidate.record;
    const id = isShown(record) ? record.recordId : undefined;
    const optionId = `${groupId}-${i}`;
    const picked = id !== undefined && (canChoose ? chosen === id : decided === id);
    const body = (
      <span className="grid min-w-0 flex-1 gap-1">
        <NamedRecordText record={record} />
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="whitespace-nowrap">{matchStepText(candidate.step)}</span>
          <span className="bg-border h-1 w-16 overflow-hidden rounded-full" aria-hidden>
            <span className="bg-primary block h-full" style={{ width: percent(candidate.score) }} />
          </span>
          <span className="text-foreground font-semibold tabular-nums">{percent(candidate.score)}</span>
          <span className="sr-only">alike</span>
        </span>
      </span>
    );
    return { candidate, id, optionId, picked, body };
  });

  return (
    <div className="grid gap-2">
      <p className="flex items-start gap-2 text-sm">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-[#b7791f]" aria-hidden />
        <span>
          Not sure which {noun} “{end.name}” means.
          {canChoose ? ' Choose one to approve the link.' : null}
        </span>
      </p>
      {canChoose ? (
        <RadioGroup
          aria-label={`The ${noun} “${end.name}” means`}
          value={chosen ?? ''}
          onValueChange={(value) => onChoose(side, value)}
          className="gap-1.5"
        >
          {items.map(({ id, optionId, picked, body }) => (
            <label
              key={optionId}
              htmlFor={optionId}
              className={cn(
                'flex items-start gap-3 rounded-md border px-3 py-2',
                id === undefined ? 'bg-muted/40 cursor-not-allowed' : 'hover:bg-accent/50 cursor-pointer',
                picked && 'border-primary bg-primary/5 hover:bg-primary/5 ring-primary/30 ring-1',
              )}
            >
              <RadioGroupItem
                id={optionId}
                value={id ?? `hidden-${optionId}`}
                disabled={id === undefined}
                className="mt-0.5"
              />
              {body}
            </label>
          ))}
        </RadioGroup>
      ) : (
        <ul className="grid gap-1.5">
          {items.map(({ optionId, picked, body }) => (
            <li
              key={optionId}
              className={cn(
                'flex items-start gap-3 rounded-md border px-3 py-2',
                picked && 'border-primary bg-primary/5',
              )}
            >
              {body}
              {picked ? (
                <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
                  <CircleCheck className="size-3.5" aria-hidden />
                  Chosen
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EndCard({
  end,
  side,
  chosen,
  decided,
  canChoose,
  onChoose,
}: {
  end: LinkEnd;
  side: Side;
  chosen: string | undefined;
  decided: string | undefined;
  canChoose: boolean;
  onChoose: (side: Side, recordId: string) => void;
}) {
  const kind = RECORD_KIND_TEXT[end.kind];
  let state: ReactNode;
  switch (end.state) {
    case 'matched':
      state = (
        <div className="grid gap-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1f5c38]">
            <CircleCheck className="size-3.5" aria-hidden />
            Matched to an existing {kind.toLowerCase()}
          </p>
          <NamedRecordText record={end.record} className="text-sm" />
          <OtherFindingsLink recordId={end.record.recordId} kind={end.record.kind} />
        </div>
      );
      break;
    case 'candidates':
      state = (
        <Candidates end={end} side={side} chosen={chosen} decided={decided} canChoose={canChoose} onChoose={onChoose} />
      );
      break;
    case 'proposed':
      state = (
        <div className="grid gap-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold">
            <FilePlus2 className="text-primary size-3.5" aria-hidden />
            Proposed new record
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/review/$id"
              params={{ id: end.findingId }}
              className="text-primary font-semibold [overflow-wrap:anywhere] hover:underline"
            >
              New {kind.toLowerCase()}: {end.name}
            </Link>
            <FindingStatusBadge status={end.status} />
          </div>
          {end.status === 'pending' ? (
            <p className="text-muted-foreground text-xs">It has to be approved before this link can be.</p>
          ) : null}
        </div>
      );
      break;
    case 'hidden':
      state = <HiddenRecord className="text-sm" />;
      break;
  }

  return (
    <div className="bg-card grid min-w-0 content-start gap-3 rounded-md border p-4">
      <div className="grid gap-0.5">
        <p className="text-muted-foreground text-xs font-semibold">{kind}</p>
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold [overflow-wrap:anywhere]">“{end.name}”</span>
          <AiMark />
        </p>
        <p className="text-muted-foreground text-xs">As the document names it</p>
      </div>
      <div className="border-t pt-3">{state}</div>
    </div>
  );
}

export function LinkEndsPanel({
  finding,
  choice,
  canChoose,
  onChoose,
}: {
  finding: LinkFindingDetail;
  choice: EndChoice;
  /** The Analyst, on a waiting finding. */
  canChoose: boolean;
  onChoose: (side: Side, recordId: string) => void;
}) {
  const { from, to, type } = finding.summary;
  return (
    <Panel title="The link" icon={ArrowRight}>
      <div className="grid items-start gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <EndCard
          end={from}
          side="from"
          chosen={choice.from}
          decided={decidedId(finding, 'from')}
          canChoose={canChoose}
          onChoose={onChoose}
        />
        <div className="flex items-center justify-center lg:mt-9" aria-label={`Link: ${linkTypeText(type)}`}>
          <span className="border-primary/30 bg-accent text-accent-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap">
            {linkTypeText(type)}
            <ArrowRight className="hidden size-3.5 lg:block" aria-hidden />
            <ArrowDown className="size-3.5 lg:hidden" aria-hidden />
          </span>
        </div>
        <EndCard
          end={to}
          side="to"
          chosen={choice.to}
          decided={decidedId(finding, 'to')}
          canChoose={canChoose}
          onChoose={onChoose}
        />
      </div>
    </Panel>
  );
}
