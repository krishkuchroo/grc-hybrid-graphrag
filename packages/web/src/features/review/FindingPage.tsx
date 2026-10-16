// One review finding (S5-005, S5-006, D27 screen 8), in the ServiceNow form style (D2): a header
// with the finding in words, its kind, status and label, and the Analyst's actions; then why it
// waits (the failed checks in plain words), where it came from (the document and the sentence
// highlighted in its passage, and what the upload put in), and its kind's details: a link's two
// ends (a match, a choice of candidates, or a proposed record), a mapping's ends and the AI's
// reason, a proposed record's details and the links waiting on it, or a duplicate pair. At the
// side: when it was found, the model and prompt version, and the decision.
// The Analyst's actions: Approve and Reject for a waiting link or mapping; for a proposed record,
// Approve opens its kind's form, pre-filled from the document (./RecordApproval); for a possible
// duplicate, the choice of which record to keep, Merge and "Not duplicates" (./MergeDuplicate);
// "Remove (false positive)" for a live or approved one (./RemoveFinding); and "Remove everything
// from this upload" on the source (./RemoveUpload). Admins see all of it read-only, with no action
// buttons; other roles get the no-access screen (D50). The API decides everything (D7); the buttons
// only show where it would allow them.
import { canApproveFinding, canRemove, canViewReviewQueue, canWorkReviewQueue } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, CircleCheck, SearchX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { isNotFound, useMe } from '@/features/records/useRecords';
import { ApproveDialog, RejectDialog } from './DecisionActions';
import { DecisionPanel, DuplicatePanel, MappingPanel, RecordProposalPanel, WhyPanel } from './FindingDetails';
import { endBlocker, LinkEndsPanel, type EndChoice, type Side } from './LinkEnds';
import { defaultKeep, MergeDialog, mergeBlocker } from './MergeDuplicate';
import { RecordApproval } from './RecordApproval';
import { RemoveDialog, removalMessage } from './RemoveFinding';
import {
  FindingStatusBadge,
  isShown,
  KindBadge,
  LinkPhrase,
  NamedRecordText,
  Panel,
  RECORD_PAGE,
  RecordLink,
  Sheet,
} from './ReviewBits';
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
  type Removal,
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

/** What the page says once something is done, and the way on from there (the new record). */
interface Done {
  message: ReactNode;
  action?: ReactNode;
}

/** What the page says once a decision is made. */
function decisionMessage(decision: Decision, finding: FindingDetail): Done {
  if (decision.status === 'rejected') {
    if (finding.kind === 'duplicate') {
      return {
        message: 'Marked as not duplicates. The two records stay separate, and the finding won’t be raised again.',
      };
    }
    const more = decision.rejectedLinkFindingIds.length;
    const extra =
      more > 0
        ? ` ${more === 1 ? 'The waiting link that pointed to it was' : `The ${more} waiting links that pointed to it were`} rejected with it.`
        : '';
    return {
      message: `Rejected. The finding is kept but no longer waits, and it won’t be raised again.${extra}`,
    };
  }
  const outcome = decision.outcome;
  if (outcome && 'result' in outcome) {
    const what = decision.kind === 'mapping' ? 'mapping' : 'link';
    return {
      message:
        outcome.result === 'created'
          ? `Approved. The ${what} is now in the graph.`
          : `Approved. The ${what} was already in the graph, so nothing new was written.`,
    };
  }
  if (outcome && 'recordId' in outcome && finding.kind === 'record') {
    const kind = finding.summary.recordKind;
    const waiting = finding.summary.linkFindings.filter((link) => link.status === 'pending').length;
    return {
      message: (
        <>
          Approved. <RecordLink kind={kind} id={outcome.recordId} number={outcome.number} /> was created from this
          proposal.
          {waiting > 0
            ? ` ${waiting === 1 ? 'The waiting link that points to it is' : `The ${waiting} waiting links that point to it are`} now ready to approve.`
            : ''}
        </>
      ),
      action: (
        <Button asChild size="sm">
          <Link to={RECORD_PAGE[kind]} params={{ id: outcome.recordId }}>
            Open {outcome.number}
          </Link>
        </Button>
      ),
    };
  }
  if (outcome && 'keptId' in outcome && finding.kind === 'duplicate') {
    const kind = finding.summary.recordKind;
    return {
      message: (
        <>
          Merged. <RecordLink kind={kind} id={outcome.keptId} number={outcome.keptNumber} /> is kept, and{' '}
          <RecordLink kind={kind} id={outcome.retiredId} number={outcome.retiredNumber} /> is retired into it.
        </>
      ),
    };
  }
  return { message: 'Approved.' };
}

export function FindingPage({ id }: { id: string }) {
  const me = useMe();
  const role = me.data?.role;
  const allowed = role !== undefined && canViewReviewQueue(role);
  const query = useReviewFinding(id, allowed);
  const [choice, setChoice] = useState<EndChoice>({});
  const [keepChoice, setKeepChoice] = useState<string | undefined>(undefined);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [stale, setStale] = useState<{ error: unknown; action: DecisionAction } | null>(null);

  const back = <BackToQueue kind={query.data?.kind} />;

  if (role === undefined || !me.data) return null;
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
  const viewer = { userId: me.data.user.id, clearance: me.data.clearance };
  const analyst = canWorkReviewQueue(role);
  const mayDecide = analyst && finding.status === 'pending';
  const mayApprove = mayDecide && canApproveFinding(role, finding.kind);
  const mayRemove = analyst && canRemove(finding.kind, finding.status);
  const keep = finding.kind === 'duplicate' ? (keepChoice ?? defaultKeep(finding)) : undefined;
  let blocker: string | null = null;
  if (mayApprove && finding.kind === 'link') blocker = linkBlocker(finding, choice);
  if (mayApprove && finding.kind === 'duplicate') blocker = mergeBlocker(finding, keep);
  const canKeep =
    mayApprove && finding.kind === 'duplicate' && isShown(finding.summary.kept) && isShown(finding.summary.other);
  const showApproval = mayApprove && approving && finding.kind === 'record';
  const model = textOrNull(finding.model);
  const promptVersion = textOrNull(finding.promptVersion);

  const choose = (side: Side, recordId: string) => {
    setChoice((current) => ({ ...current, [side]: recordId }));
  };
  const decided = (decision: Decision) => {
    setChoice({});
    setApproving(false);
    setStale(null);
    setDone(decisionMessage(decision, finding));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const removed = (removal: Removal) => {
    setStale(null);
    setDone({ message: removalMessage(removal) });
  };
  const refused = (action: DecisionAction) => (error: unknown) => {
    setDone(null);
    setApproving(false);
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

  const actions: ReactNode[] = [];
  if (mayApprove && (finding.kind === 'link' || finding.kind === 'mapping')) {
    actions.push(
      <ApproveDialog
        key="approve"
        finding={finding}
        body={finding.kind === 'link' ? linkBody(finding, choice) : {}}
        blocker={blocker}
        preview={preview}
        onApproved={decided}
        onStale={refused('approve')}
      />,
    );
  }
  if (mayApprove && finding.kind === 'record' && !approving) {
    actions.push(
      <Button
        key="approve"
        type="button"
        onClick={() => {
          setDone(null);
          setStale(null);
          setApproving(true);
        }}
      >
        <CircleCheck aria-hidden />
        Approve
      </Button>,
    );
  }
  if (mayApprove && finding.kind === 'duplicate') {
    actions.push(
      <MergeDialog
        key="merge"
        finding={finding}
        keep={keep}
        blocker={blocker}
        onMerged={decided}
        onStale={refused('approve')}
      />,
    );
  }
  if (mayDecide) {
    actions.push(<RejectDialog key="reject" finding={finding} onRejected={decided} onStale={refused('reject')} />);
  }
  if (mayRemove) {
    actions.push(<RemoveDialog key="remove" finding={finding} onRemoved={removed} onStale={refused('remove')} />);
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
          {actions.length > 0 ? (
            <div className="ml-auto grid justify-items-end gap-1.5">
              <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
              {blocker ? (
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
                <p>{done.message}</p>
                {done.action ? <div className="mt-1">{done.action}</div> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {stale ? (
            <ApiProblem
              error={decisionRefusal(stale.error, stale.action, finding.kind)}
              title={decisionRefusalTitle(stale.action, finding.kind)}
            />
          ) : null}
          {showApproval && finding.kind === 'record' ? (
            <RecordApproval
              finding={finding}
              viewer={viewer}
              onApproved={decided}
              onStale={refused('approve')}
              onCancel={() => setApproving(false)}
            />
          ) : null}
          <WhyPanel finding={finding} />
          {finding.kind === 'link' || finding.kind === 'record' ? (
            <SourcePanel finding={finding} canRemoveUpload={analyst} />
          ) : null}
          {finding.kind === 'link' ? (
            <LinkEndsPanel finding={finding} choice={choice} canChoose={mayApprove} onChoose={choose} />
          ) : null}
          {finding.kind === 'mapping' ? <MappingPanel finding={finding} /> : null}
          {finding.kind === 'record' ? <RecordProposalPanel finding={finding} showLinks={!showApproval} /> : null}
          {finding.kind === 'duplicate' ? (
            <DuplicatePanel finding={finding} keep={keep} onKeep={canKeep ? setKeepChoice : undefined} />
          ) : null}
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
