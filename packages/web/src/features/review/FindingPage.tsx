// One review finding (S5-005, D27 screen 8), in the ServiceNow form style (D2): a header with the
// finding in words, its kind, status and label, and the Analyst's actions; then why it waits (the
// failed checks in plain words), where it came from (the document and the sentence highlighted in
// its passage), and its kind's details: a link's two ends (a match, a choice of candidates, or a
// proposed record), a mapping's ends and the AI's reason, a proposed record's details, or a
// duplicate pair. At the side: when it was found, the model and prompt version, and the decision.
// Admins see all of it read-only; other roles get the no-access screen (D50). The API decides
// everything (D7); the buttons only show where it would allow them.
import { canApproveFinding, canViewReviewQueue, canWorkReviewQueue } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, CircleCheck, SearchX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { isNotFound, useMe } from '@/features/records/useRecords';
import { ApproveDialog, RejectDialog } from './DecisionActions';
import { DecisionPanel, DuplicatePanel, MappingPanel, RecordProposalPanel, WhyPanel } from './FindingDetails';
import { endBlocker, LinkEndsPanel, type EndChoice, type Side } from './LinkEnds';
import { FindingStatusBadge, isShown, KindBadge, LinkPhrase, NamedRecordText, Panel, Sheet } from './ReviewBits';
import { ReviewNoAccess } from './ReviewPage';
import { SourcePanel } from './SourcePanel';
import {
  DEFAULT_KIND,
  isForbidden,
  useReviewFinding,
  type Decision,
  type FindingDetail,
  type LinkEnd,
  type LinkFindingDetail,
  type ReviewSearch,
} from './useReview';
import {
  decisionRefusal,
  decisionRefusalTitle,
  HIDDEN_RECORD_INLINE,
  linkTypeText,
  RECORD_KIND_TEXT,
  textOrNull,
  type DecisionAction,
} from './words';

function BackToQueue({ kind }: { kind: FindingDetail['kind'] | undefined }) {
  const search: ReviewSearch = kind && kind !== DEFAULT_KIND ? { kind } : {};
  return (
    <Link to="/review" search={search} className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Analyst review
    </Link>
  );
}

/** A link end's name in the page title. */
function endTitle(end: LinkEnd): string {
  if (end.state === 'matched') return end.record.name;
  if (end.state === 'hidden') return HIDDEN_RECORD_INLINE;
  return `“${end.name}”`;
}

function namedTitle(record: { hidden: true } | { name: string }): string {
  return 'name' in record ? record.name : HIDDEN_RECORD_INLINE;
}

/** The finding in words, as the page's title. */
function titleOf(finding: FindingDetail): string {
  switch (finding.kind) {
    case 'link':
      return `${endTitle(finding.summary.from)} ${linkTypeText(finding.summary.type)} ${endTitle(finding.summary.to)}`;
    case 'record':
      return `New ${RECORD_KIND_TEXT[finding.summary.recordKind].toLowerCase()}: ${finding.summary.name}`;
    case 'duplicate':
      return `${namedTitle(finding.summary.kept)} and ${namedTitle(finding.summary.other)}`;
    case 'mapping': {
      const end = (record: typeof finding.summary.from) =>
        isShown(record) ? (textOrNull(record.code) ?? record.name) : HIDDEN_RECORD_INLINE;
      return `${end(finding.summary.from)} ${linkTypeText(finding.summary.type)} ${end(finding.summary.to)}`;
    }
  }
}

/** A link end as the approval will write it: its record, the chosen candidate, or the proposal. */
function endPreview(end: LinkEnd, chosen: string | undefined): ReactNode {
  switch (end.state) {
    case 'matched':
      return <NamedRecordText record={end.record} plain />;
    case 'candidates': {
      const picked = end.candidates.find((c) => isShown(c.record) && c.record.recordId === chosen);
      return picked ? <NamedRecordText record={picked.record} plain /> : <span>“{end.name}”</span>;
    }
    case 'proposed':
      return (
        <span>
          The new {RECORD_KIND_TEXT[end.kind].toLowerCase()} “{end.name}”
        </span>
      );
    case 'hidden':
      return <span>{HIDDEN_RECORD_INLINE}</span>;
  }
}

/** The approve body for a link: a chosen record only for an end that offers candidates. */
function linkBody(finding: LinkFindingDetail, choice: EndChoice): { from?: string; to?: string } {
  const body: { from?: string; to?: string } = {};
  if (finding.summary.from.state === 'candidates' && choice.from) body.from = choice.from;
  if (finding.summary.to.state === 'candidates' && choice.to) body.to = choice.to;
  return body;
}

function linkBlocker(finding: LinkFindingDetail, choice: EndChoice): string | null {
  return endBlocker(finding.summary.from, choice.from) ?? endBlocker(finding.summary.to, choice.to);
}

/** What the page says once a decision is made. */
function decisionMessage(decision: Decision): string {
  if (decision.status === 'rejected') {
    const more = decision.rejectedLinkFindingIds.length;
    const extra =
      more > 0
        ? ` ${more === 1 ? 'The waiting link that pointed to it was' : `The ${more} waiting links that pointed to it were`} rejected with it.`
        : '';
    return `Rejected. The finding is kept but no longer waits, and it won’t be raised again.${extra}`;
  }
  const outcome = decision.outcome;
  const what = decision.kind === 'mapping' ? 'mapping' : 'link';
  if (outcome && 'result' in outcome) {
    return outcome.result === 'created'
      ? `Approved. The ${what} is now in the graph.`
      : `Approved. The ${what} was already in the graph, so nothing new was written.`;
  }
  return 'Approved.';
}

export function FindingPage({ id }: { id: string }) {
  const me = useMe();
  const role = me.data?.role;
  const allowed = role !== undefined && canViewReviewQueue(role);
  const query = useReviewFinding(id, allowed);
  const [choice, setChoice] = useState<EndChoice>({});
  const [done, setDone] = useState<string | null>(null);
  const [stale, setStale] = useState<{ error: unknown; action: DecisionAction } | null>(null);

  const back = <BackToQueue kind={query.data?.kind} />;

  if (role === undefined) return null;
  if (!allowed || isForbidden(query.error)) return <ReviewNoAccess role={role} />;
  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the finding…</span>
      </div>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) {
      return (
        <div className="px-8 py-10">
          <div className="bg-card mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border px-6 py-12 text-center">
            <span className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-full">
              <SearchX className="size-5" aria-hidden />
            </span>
            <h1 className="text-lg font-semibold">Finding not found</h1>
            <p className="text-muted-foreground text-sm">This finding doesn’t exist or you can’t see it.</p>
            <div className="text-sm">{back}</div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-sm">{back}</div>
        <ApiProblem error={query.error} title="This finding couldn’t be opened" />
      </div>
    );
  }

  const finding = query.data;
  const waiting = finding.status === 'pending';
  const mayWork = canWorkReviewQueue(role) && waiting;
  const mayApprove =
    mayWork && (finding.kind === 'link' || finding.kind === 'mapping') && canApproveFinding(role, finding.kind);
  const blocker = finding.kind === 'link' ? linkBlocker(finding, choice) : null;
  const model = textOrNull(finding.model);
  const promptVersion = textOrNull(finding.promptVersion);

  const choose = (side: Side, recordId: string) => {
    setChoice((current) => ({ ...current, [side]: recordId }));
  };
  const decided = (decision: Decision) => {
    setChoice({});
    setStale(null);
    setDone(decisionMessage(decision));
  };
  const refused = (action: DecisionAction) => (error: unknown) => {
    setDone(null);
    setStale({ error, action });
  };

  let preview: ReactNode = null;
  if (finding.kind === 'link') {
    preview = (
      <LinkPhrase
        from={endPreview(finding.summary.from, choice.from)}
        type={finding.summary.type}
        to={endPreview(finding.summary.to, choice.to)}
      />
    );
  } else if (finding.kind === 'mapping') {
    preview = (
      <LinkPhrase
        from={<NamedRecordText record={finding.summary.from} plain />}
        type={finding.summary.type}
        to={<NamedRecordText record={finding.summary.to} plain />}
      />
    );
  }

  return (
    <>
      <div className="bg-card border-b px-8 pt-4 pb-5">
        <div className="text-muted-foreground mb-2 text-xs">{back}</div>
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid min-w-0 flex-1 gap-2">
            <h1 className="max-w-[60ch] text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {titleOf(finding)}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={finding.kind} />
              <FindingStatusBadge status={finding.status} />
              <LabelBadge label={finding.label} />
            </div>
          </div>
          {mayWork ? (
            <div className="ml-auto grid justify-items-end gap-1.5">
              <div className="flex items-center gap-2">
                {mayApprove ? (
                  <ApproveDialog
                    finding={finding}
                    body={finding.kind === 'link' ? linkBody(finding, choice) : {}}
                    blocker={blocker}
                    preview={preview}
                    onApproved={decided}
                    onStale={refused('approve')}
                  />
                ) : null}
                <RejectDialog finding={finding} onRejected={decided} onStale={refused('reject')} />
              </div>
              {mayApprove && blocker ? (
                <p className="text-muted-foreground max-w-[22rem] text-right text-xs" role="status">
                  {blocker}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-4">
          {done ? (
            <Alert variant="info" role="status">
              <CircleCheck aria-hidden />
              <AlertDescription>
                <p>{done}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {stale ? (
            <ApiProblem
              error={decisionRefusal(stale.error, stale.action, finding.kind)}
              title={decisionRefusalTitle(stale.action)}
            />
          ) : null}
          <WhyPanel finding={finding} />
          {finding.kind === 'link' || finding.kind === 'record' ? <SourcePanel finding={finding} /> : null}
          {finding.kind === 'link' ? (
            <LinkEndsPanel finding={finding} choice={choice} canChoose={mayApprove} onChoose={choose} />
          ) : null}
          {finding.kind === 'mapping' ? <MappingPanel finding={finding} /> : null}
          {finding.kind === 'record' ? <RecordProposalPanel finding={finding} /> : null}
          {finding.kind === 'duplicate' ? <DuplicatePanel finding={finding} /> : null}
        </div>

        <aside className="grid content-start gap-4">
          <Panel title="Finding">
            <Sheet
              items={[
                { label: 'Kind', value: <KindBadge kind={finding.kind} /> },
                { label: 'Status', value: <FindingStatusBadge status={finding.status} /> },
                { label: 'Label', value: <LabelBadge label={finding.label} /> },
                { label: 'Found', value: formatMoment(finding.createdAt) },
              ]}
            />
            {model || promptVersion ? (
              <p className="text-muted-foreground border-t px-5 py-3 text-xs leading-relaxed">
                Found by {model ? <span className="font-mono whitespace-nowrap">{model}</span> : 'the extraction'}
                {promptVersion ? (
                  <>
                    {' '}
                    with prompt <span className="font-mono whitespace-nowrap">{promptVersion}</span>
                  </>
                ) : null}
                .
              </p>
            ) : null}
          </Panel>
          <DecisionPanel finding={finding} />
        </aside>
      </div>
    </>
  );
}
