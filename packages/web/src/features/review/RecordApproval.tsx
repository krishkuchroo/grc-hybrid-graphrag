// Approving a proposed new record (S5-006; D24, D38, D43, D51, D198): S1's create form for the
// proposal's kind, built from the shared schema, pre-filled with the name and with each of Gemma's
// details that fits a field (./prefill). The owner defaults to the Analyst. The label picker offers
// nothing below the finding's own label or its document's (only an Admin may lower a label, and the
// Analyst isn't one) and nothing above the Analyst's clearance. The form also lists the link
// findings that point to the proposal: approving it is what lets them be approved. The API checks
// all of it again (D7): its refusals show in plain words with their reference ID (D47).
import { defaultLabel, isVisible, LABELS, type Label, type ProposedRecordKind } from '@grc/shared';
import { ClipboardCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { PostReviewFindingsIdApproveBody } from '@/api/client';
import { ApiProblem } from '@/features/records/ApiProblem';
import { CONTROL_FORM_FIELDS } from '@/features/records/controls/ControlPage';
import { words } from '@/features/records/format';
import { INCIDENT_FORM_FIELDS } from '@/features/records/incidents/IncidentPage';
import { LabelBadge } from '@/features/records/LabelBadge';
import { POLICY_FORM_FIELDS } from '@/features/records/policies/PolicyPage';
import { RecordForm, type FormFieldDef, type FormValues } from '@/features/records/RecordForm';
import { RISK_FORM_FIELDS } from '@/features/records/risks/RiskPage';
import { NoteField, withNote } from './DecisionActions';
import { WaitingLinks } from './FindingDetails';
import { prefillProposal } from './prefill';
import { Panel } from './ReviewBits';
import { refusalMeansStale, useApproveFinding, type Decision, type RecordFindingDetail } from './useReview';
import { decisionRefusal, decisionRefusalTitle, RECORD_KIND_TEXT } from './words';

/** Each kind's own fields, as S1's create pages have them. */
export const PROPOSAL_FORM_FIELDS: Readonly<Record<ProposedRecordKind, readonly FormFieldDef[]>> = {
  risk: RISK_FORM_FIELDS,
  control: CONTROL_FORM_FIELDS,
  policy: POLICY_FORM_FIELDS,
  incident: INCIDENT_FORM_FIELDS,
};

function rank(label: Label): number {
  return LABELS.indexOf(label);
}

function higher(a: Label, b: Label): Label {
  return rank(a) >= rank(b) ? a : b;
}

/** The lowest label the new record may have: the finding's, or its document's if that is higher. */
export function labelFloor(finding: RecordFindingDetail): Label {
  return finding.document ? higher(finding.label, finding.document.label) : finding.label;
}

/** The labels the Analyst may give the new record: none below the floor, none above their clearance. */
export function approvalLabelChoices(floor: Label, clearance: string): Label[] {
  return LABELS.filter((label) => isVisible(label, floor) && isVisible(clearance, label));
}

/** The label to start with: the kind's usual label, raised to the floor, within the choices. */
function startingLabel(kind: ProposedRecordKind, floor: Label, choices: readonly Label[]): Label | undefined {
  const wanted = higher(defaultLabel(kind), floor);
  if (choices.includes(wanted)) return wanted;
  return choices[choices.length - 1];
}

/** A detail's key in plain words: `occurredAt` and `occurred_at` are `occurred at`. */
function detailWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function RecordApproval({
  finding,
  viewer,
  onApproved,
  onStale,
  onCancel,
}: {
  finding: RecordFindingDetail;
  viewer: { userId: string; clearance: string };
  onApproved: (decision: Decision) => void;
  /** A refusal that means the page is out of date (decided by someone else, or gone). */
  onStale: (error: unknown) => void;
  onCancel: () => void;
}) {
  const kind = finding.summary.recordKind;
  const noun = RECORD_KIND_TEXT[kind].toLowerCase();
  const fields = PROPOSAL_FORM_FIELDS[kind];
  const [note, setNote] = useState('');
  const approve = useApproveFinding(finding.id);

  const floor = labelFloor(finding);
  const choices = approvalLabelChoices(floor, viewer.clearance);
  const label = startingLabel(kind, floor, choices);
  // Worked out once, when the form opens: the Analyst's own changes are never filled over.
  const [prefill] = useState(() => prefillProposal(kind, fields, finding.summary.name, finding.summary.details));
  const pending = finding.summary.linkFindings.filter((link) => link.status === 'pending');

  if (label === undefined) {
    return (
      <Panel title={`Approve as a new ${noun}`} icon={ClipboardCheck}>
        <p className="text-muted-foreground px-5 py-4 text-sm">
          The document is labelled above your clearance, so you can’t create a record from it. Reject the proposal, or
          ask an Analyst cleared for it.
        </p>
      </Panel>
    );
  }

  const initial: FormValues = { ...prefill.values, owner: viewer.userId, label };
  const filled = ['Name', ...prefill.filled];

  return (
    <Panel title={`Approve as a new ${noun}`} icon={ClipboardCheck}>
      <div className="grid gap-5 px-5 py-5">
        <div className="grid gap-2 text-sm leading-relaxed">
          <p>
            Check what the document says, fill in what’s missing, and approve to create the {noun}. It’s created as one
            the AI found, with you as its reviewer, and the decision goes in the audit trail.
          </p>
          <p className="text-muted-foreground flex items-start gap-2">
            <Sparkles className="text-primary mt-1 size-3.5 shrink-0" aria-hidden />
            <span>
              Filled in from the document: {listText(filled)}.
              {prefill.unused.length > 0 ? (
                <>
                  {' '}
                  Not used, because no field takes them as written:{' '}
                  {prefill.unused.map(({ key, value }, i) => (
                    <span key={key}>
                      {i > 0 ? ', ' : null}
                      {detailWords(key)} <span className="text-foreground">“{value}”</span>
                    </span>
                  ))}
                  .
                </>
              ) : null}
            </span>
          </p>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>The label can’t be lower than</span>
            <LabelBadge label={floor} />
            <span>
              ({finding.document && finding.document.label === floor ? 'the document’s' : 'the finding’s'}) or higher
              than your clearance,
            </span>
            <span className="text-foreground font-semibold">{words(viewer.clearance)}.</span>
          </p>
        </div>

        <RecordForm
          kind={kind}
          mode="create"
          fields={fields}
          initial={initial}
          labelChoices={choices}
          submitText={`Approve and create ${noun}`}
          pendingText="Approving…"
          pending={approve.isPending}
          notice={
            approve.error ? (
              <ApiProblem
                error={decisionRefusal(approve.error, 'approve', 'record')}
                title={decisionRefusalTitle('approve', 'record')}
              />
            ) : null
          }
          extra={
            <div className="grid gap-5">
              <NoteField value={note} onChange={setNote} disabled={approve.isPending} />
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">
                  {pending.length === 0
                    ? 'No links are waiting on this proposal'
                    : `Waiting on this proposal: ${pending.length} ${pending.length === 1 ? 'link' : 'links'}`}
                </h3>
                {pending.length > 0 ? (
                  <>
                    <p className="text-muted-foreground text-sm">
                      Once the {noun} is created, {pending.length === 1 ? 'this link is' : 'these links are'} ready to
                      approve on {pending.length === 1 ? 'its' : 'their'} own page.
                    </p>
                    <div className="overflow-hidden rounded-md border">
                      <WaitingLinks links={finding.summary.linkFindings} noun={noun} proposal={finding.status} />
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          }
          onCancel={() => {
            approve.reset();
            onCancel();
          }}
          onSubmit={({ all }) => {
            if (approve.isPending) return;
            const body = withNote({ record: all }, note) as PostReviewFindingsIdApproveBody;
            approve.mutate(body, {
              onSuccess: (decision) => onApproved(decision),
              onError: (error) => {
                if (refusalMeansStale(error)) onStale(error);
              },
            });
          }}
        />
      </div>
    </Panel>
  );
}
