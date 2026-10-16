// The parts of a finding's page besides its link ends and source (S5-005): why it waits (the failed
// checks in plain words), a suggested mapping's two ends and Gemma's reason, a proposed new
// record's details and the links waiting on it, a possible duplicate pair, and the decision (who,
// when, the note, and what it made, linking to it). Records the reader may not see read "A record
// you can't see" (D51, D57); an outcome naming one is left out by the API.
import { ruleCheckText } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Copy,
  FilePlus2,
  Gavel,
  Info,
  MessageSquareQuote,
  Network,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { frameworkName } from '@/features/frameworks/useFrameworks';
import { formatMoment, words } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { StatusBadge } from '@/features/records/RecordPage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AiMark,
  FindingStatusBadge,
  HiddenRecord,
  isShown,
  LinkEndText,
  LinkPhrase,
  Panel,
  RecordLink,
  Sheet,
} from './ReviewBits';
import { OtherFindingsLink } from './LinkEnds';
import type { DuplicateFindingDetail, FindingDetail, MappingFindingDetail, RecordFindingDetail } from './useReview';
import {
  linkEndsOf,
  linkTypeText,
  matchStepText,
  percent,
  personText,
  RECORD_KIND_TEXT,
  textOrNull,
  withArticle,
} from './words';

// ---- Why it waits ------------------------------------------------------------------------------

/** What each failed check means for the Analyst, under its short words. */
const CHECK_HELP: Record<string, string> = {
  same_sentence:
    'The two names weren’t found together in the sentence the link was read from. Read the passage to see whether the link holds.',
  ontology_fit:
    'This kind of link, or its direction, doesn’t fit these kinds of record. Approving is refused unless the records you settle on fit it.',
  both_ends_known:
    'At least one name didn’t clearly match one record. Choose the record it means, or approve the proposed record first.',
};

function CheckList({ checks, help }: { checks: readonly string[]; help: boolean }) {
  return (
    <ul className="grid gap-3">
      {checks.map((check) => (
        <li key={check} className="flex items-start gap-2.5">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-[#b7791f]" aria-hidden />
          <span className="grid gap-0.5">
            <span className="text-sm font-semibold">{ruleCheckText(check)}</span>
            {help && CHECK_HELP[check] ? (
              <span className="text-muted-foreground text-sm leading-relaxed">{CHECK_HELP[check]}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Note({ icon: Icon = Info, children }: { icon?: typeof Info; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2.5 text-sm leading-relaxed">
      <Icon className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Why a finding waits for the Analyst, or (once decided) why it waited. A live link says the
 * rule checks passed instead. */
export function WhyPanel({ finding }: { finding: FindingDetail }) {
  if (finding.status === 'live') {
    return (
      <Panel title="Why it went live" icon={CircleCheck}>
        <div className="px-5 py-4">
          <Note icon={CircleCheck}>
            The rule checks passed: the sentence names both records, the link fits them, and both are records already
            known. It went live without waiting for review.
          </Note>
        </div>
      </Panel>
    );
  }
  const waiting = finding.status === 'pending';
  const title = waiting ? 'Why it’s waiting' : 'Why it waited';
  let body: ReactNode;
  switch (finding.kind) {
    case 'link':
      body =
        finding.summary.failedChecks.length > 0 ? (
          <CheckList checks={finding.summary.failedChecks} help={waiting} />
        ) : (
          <Note>No rule check failed, but the link wasn’t made live on its own.</Note>
        );
      break;
    case 'record': {
      const noun = RECORD_KIND_TEXT[finding.summary.recordKind].toLowerCase();
      body = (
        <Note icon={FilePlus2}>
          {waiting
            ? `The document names ${withArticle(noun)} that isn’t on record yet. It’s only created once an Analyst approves it, and links that point to it wait until then.`
            : `The document named ${withArticle(noun)} that wasn’t on record, and it waited for an Analyst to approve it.`}
        </Note>
      );
      break;
    }
    case 'duplicate': {
      const noun = RECORD_KIND_TEXT[finding.summary.recordKind].toLowerCase();
      body = (
        <Note icon={Copy}>
          Matching found two {noun} records that may be one: {matchStepText(finding.summary.step).toLowerCase()},{' '}
          {percent(finding.summary.score)} alike.
          {waiting ? ' They stay separate until an Analyst merges them.' : ' Only an Analyst merges records.'}
        </Note>
      );
      break;
    }
    case 'mapping':
      body = (
        <Note icon={Network}>
          The AI suggested this mapping. Suggested mappings always wait for an Analyst before they count toward coverage
          {waiting ? '' : ', so it waited for one'}.
        </Note>
      );
      break;
  }
  return (
    <Panel title={title} icon={CircleAlert}>
      <div className="px-5 py-4">{body}</div>
    </Panel>
  );
}

// ---- A suggested mapping ---------------------------------------------------------------------

type MappingEnd = MappingFindingDetail['summary']['from'];

function MappingEndCard({ end, role }: { end: MappingEnd; role: string }) {
  if (!isShown(end)) {
    return (
      <div className="bg-card grid content-start gap-2 rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-semibold">{role}</p>
        <HiddenRecord className="text-sm" />
      </div>
    );
  }
  const code = textOrNull(end.code);
  const title = textOrNull(end.title);
  const framework = textOrNull(end.framework);
  return (
    <div className="bg-card grid min-w-0 content-start gap-2 rounded-md border p-4">
      <p className="text-muted-foreground text-xs font-semibold">{RECORD_KIND_TEXT[end.kind]}</p>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {code ? <span className="font-semibold">{code}</span> : null}
        <span className="[overflow-wrap:anywhere]">{title ?? end.name}</span>
      </p>
      {framework ? (
        <p className="text-muted-foreground text-xs">
          {end.kind === 'requirement' ? frameworkName(framework) : `Framework as written: ${framework}`}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <RecordLink kind={end.kind} id={end.recordId} number={end.number} className="text-sm" />
        <LabelBadge label={end.label} />
        {end.status !== 'active' ? <StatusBadge status={end.status} /> : null}
      </div>
      <OtherFindingsLink recordId={end.recordId} kind={end.kind} />
    </div>
  );
}

export function MappingPanel({ finding }: { finding: MappingFindingDetail }) {
  const { from, to, type, reason } = finding.summary;
  const ends = linkEndsOf(type);
  return (
    <Panel title="The mapping" icon={Network}>
      <div className="grid items-start gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <MappingEndCard end={from} role={ends ? RECORD_KIND_TEXT[ends.from] : 'From'} />
        <div className="flex items-center justify-center lg:mt-9">
          <span className="border-primary/30 bg-accent text-accent-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap">
            {linkTypeText(type)}
            <ArrowRight className="hidden size-3.5 lg:block" aria-hidden />
            <ArrowDown className="size-3.5 lg:hidden" aria-hidden />
          </span>
        </div>
        <MappingEndCard end={to} role={ends ? RECORD_KIND_TEXT[ends.to] : 'To'} />
      </div>
      <div className="grid gap-2 border-t px-5 py-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold">
          <MessageSquareQuote className="text-muted-foreground size-3.5" aria-hidden />
          Why it was suggested
          <AiMark />
        </h3>
        <p className="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{reason}</p>
      </div>
    </Panel>
  );
}

// ---- A proposed new record ------------------------------------------------------------------

export function RecordProposalPanel({ finding }: { finding: RecordFindingDetail }) {
  const { recordKind, name, linkFindings } = finding.summary;
  const details = finding.summary.details;
  const detailItems =
    details && typeof details === 'object'
      ? Object.entries(details as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => ({ label: words(key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()), value }))
      : [];
  const noun = RECORD_KIND_TEXT[recordKind].toLowerCase();
  return (
    <>
      <Panel title={`Proposed ${noun}`} icon={FilePlus2} toolbar={<AiMark />}>
        <Sheet
          items={[
            { label: 'Kind', value: RECORD_KIND_TEXT[recordKind] },
            { label: 'Name', value: name, wide: true },
            ...detailItems,
          ]}
        />
        {detailItems.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-3 text-xs">The document gave no other details.</p>
        ) : null}
      </Panel>
      <Panel title="Links waiting on it">
        {linkFindings.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">No link findings point to this proposed {noun}.</p>
        ) : (
          <Table>
            <TableHeader className="bg-muted/70">
              <TableRow>
                <TableHead>Link</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linkFindings.map((link) => {
                const self = <span className="font-semibold">This {noun}</span>;
                const other = <LinkEndText end={link.other} />;
                return (
                  <TableRow key={link.id} className="even:bg-muted/30">
                    <TableCell className="whitespace-normal">
                      <Link to="/review/$id" params={{ id: link.id }} className="hover:text-primary block">
                        <LinkPhrase
                          from={link.side === 'from' ? self : other}
                          type={link.type}
                          to={link.side === 'to' ? self : other}
                        />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <FindingStatusBadge status={link.status} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}

// ---- A possible duplicate pair ----------------------------------------------------------------

type DuplicateRecord = DuplicateFindingDetail['summary']['kept'];

function DuplicateCard({ record, role }: { record: DuplicateRecord; role: string }) {
  if (!isShown(record)) {
    return (
      <div className="bg-card grid content-start gap-2 rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-semibold">{role}</p>
        <HiddenRecord className="text-sm" />
      </div>
    );
  }
  return (
    <div className="bg-card grid min-w-0 content-start gap-3 rounded-md border p-4">
      <p className="text-muted-foreground text-xs font-semibold">{role}</p>
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <RecordLink kind={record.kind} id={record.recordId} number={record.number} className="text-sm" />
          <StatusBadge status={record.status} />
          <LabelBadge label={record.label} />
        </div>
        <p className="text-sm [overflow-wrap:anywhere]">{record.name}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground text-xs font-semibold">Owner</dt>
        <dd>{personText(record.owner)}</dd>
        <dt className="text-muted-foreground text-xs font-semibold">Links</dt>
        <dd className="tabular-nums">{record.linkCount}</dd>
        <dt className="text-muted-foreground text-xs font-semibold">Source IDs</dt>
        <dd className="flex flex-wrap gap-1">
          {record.sourceIds.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            record.sourceIds.map((sourceId) => (
              <span key={sourceId} className="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-xs">
                {sourceId}
              </span>
            ))
          )}
        </dd>
      </dl>
    </div>
  );
}

export function DuplicatePanel({ finding }: { finding: DuplicateFindingDetail }) {
  const { kept, other, step, score, recordKind } = finding.summary;
  const merged = finding.status === 'approved' || finding.outcome !== null;
  return (
    <Panel
      title={`Possible duplicate ${RECORD_KIND_TEXT[recordKind].toLowerCase()}s`}
      icon={Copy}
      toolbar={
        <span className="text-muted-foreground text-xs">
          {matchStepText(step)}, <span className="text-foreground font-semibold tabular-nums">{percent(score)}</span>{' '}
          alike
        </span>
      }
    >
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <DuplicateCard record={kept} role={merged ? 'Kept' : 'Kept if they’re merged'} />
        <DuplicateCard record={other} role={merged ? 'Merged into the kept record' : 'The other record'} />
      </div>
    </Panel>
  );
}

// ---- The decision -----------------------------------------------------------------------------

function Outcome({ finding }: { finding: FindingDetail }) {
  if (finding.status === 'rejected') {
    return <span className="text-muted-foreground">Nothing changed in the graph.</span>;
  }
  if (finding.outcome === null) {
    return finding.status === 'approved' || finding.status === 'removed' ? (
      <span className="text-muted-foreground">What it made is a record you can’t see.</span>
    ) : null;
  }
  switch (finding.kind) {
    case 'link':
    case 'mapping': {
      const o = finding.outcome;
      const ends = linkEndsOf(o.type);
      const phrase = (
        <LinkPhrase
          from={<RecordLink kind={ends?.from ?? ''} id={o.fromId} number={o.fromNumber} />}
          type={o.type}
          to={<RecordLink kind={ends?.to ?? ''} id={o.toId} number={o.toNumber} />}
        />
      );
      const what = finding.kind === 'link' ? 'link' : 'mapping';
      return (
        <span className="grid gap-1.5">
          <span>
            {o.result === 'created'
              ? `Wrote the ${what}:`
              : `The ${what} was already in the graph, so nothing new was written:`}
          </span>
          {phrase}
          {o.removed ? (
            <span className="text-muted-foreground">
              {o.removed.graph === 'deleted'
                ? `Later removed: the ${what} was deleted from the graph.`
                : `Later removed: the ${what} was already gone from the graph.`}
            </span>
          ) : null}
        </span>
      );
    }
    case 'record': {
      const o = finding.outcome;
      return (
        <span className="grid gap-1.5">
          <span>
            Created <RecordLink kind={finding.summary.recordKind} id={o.recordId} number={o.number} />
          </span>
          {o.removed ? (
            <span className="text-muted-foreground">
              {o.removed.graph === 'retired'
                ? 'Later removed: the record was retired.'
                : 'Later removed: the record was already retired.'}
            </span>
          ) : null}
        </span>
      );
    }
    case 'duplicate': {
      const o = finding.outcome;
      const kind = finding.summary.recordKind;
      return (
        <span>
          Kept <RecordLink kind={kind} id={o.keptId} number={o.keptNumber} /> and merged{' '}
          <RecordLink kind={kind} id={o.retiredId} number={o.retiredNumber} /> into it.
        </span>
      );
    }
  }
}

/** The decision, once there is one: who, when, the note, and what it made or removed. */
export function DecisionPanel({ finding }: { finding: FindingDetail }) {
  if (finding.decidedAt === null && finding.decidedBy === null) return null;
  const note = textOrNull(finding.note);
  return (
    <Panel title="Decision" icon={Gavel}>
      <Sheet
        items={[
          { label: 'Decision', value: <FindingStatusBadge status={finding.status} />, wide: true },
          { label: 'Decided by', value: personText(finding.decidedBy), wide: true },
          { label: 'When', value: finding.decidedAt ? formatMoment(finding.decidedAt) : '—', wide: true },
          {
            label: 'Note',
            value: note ? (
              <span className="whitespace-pre-wrap">{note}</span>
            ) : (
              <span className="text-muted-foreground">No note</span>
            ),
            wide: true,
          },
          { label: 'Outcome', value: <Outcome finding={finding} />, wide: true },
        ]}
      />
    </Panel>
  );
}

/** A record named in a heading: its name, or "a record you can't see". */
export function recordName(record: { hidden: true } | { name: string }, hidden: string): string {
  return 'name' in record ? record.name : hidden;
}
