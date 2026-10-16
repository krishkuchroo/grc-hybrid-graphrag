// The Analyst's decisions on a waiting finding (S5-005; D24, D38, D50): Approve (links and
// mappings) with an optional note, and Reject (every kind, "Not duplicates" for a possible
// duplicate) after a confirmation, with an optional note. A proposed record is approved through its
// form (./RecordApproval) and a duplicate merged through its own confirmation (./MergeDuplicate);
// a live or approved finding is removed as a false positive (./RemoveFinding). Only the Analyst
// sees them (`canWorkReviewQueue`; approving a mapping also needs `canApproveFinding`); the API
// decides anyway (D7), so its refusals show in the dialog in plain words with their reference ID
// (D47). After a decision the page shows the new status, and the queue, its counts and the record
// pages ask again (useReview).
import { REVIEW_NOTE_MAX_LENGTH, type ReviewFindingKind } from '@grc/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label as FieldLabel } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiProblem } from '@/features/records/ApiProblem';
import { refusalMeansStale, useApproveFinding, useRejectFinding, type Decision, type FindingDetail } from './useReview';
import { decisionRefusal, decisionRefusalTitle } from './words';

/** The optional note that goes with a decision into the audit trail. */
export function NoteField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const hintId = useId();
  const left = REVIEW_NOTE_MAX_LENGTH - value.length;
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>
        Note <span className="text-muted-foreground font-normal">(optional)</span>
      </FieldLabel>
      <Textarea
        id={id}
        value={value}
        maxLength={REVIEW_NOTE_MAX_LENGTH}
        disabled={disabled}
        rows={3}
        aria-describedby={hintId}
        placeholder="Why you decided this way, for whoever reads the audit trail"
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={hintId} className="text-muted-foreground flex justify-between gap-3 text-xs">
        <span>The note is kept with the decision in the audit trail.</span>
        <span className="tabular-nums">{left.toLocaleString('en-US')} left</span>
      </p>
    </div>
  );
}

export function withNote<T extends object>(body: T, note: string): T & { note?: string } {
  const trimmed = note.trim();
  return trimmed === '' ? body : { ...body, note: trimmed };
}

const APPROVE_TEXT: Partial<Record<ReviewFindingKind, { title: string; description: string }>> = {
  link: {
    title: 'Approve this link?',
    description:
      'The link is written to the graph as one the AI found, with you as its reviewer, and shows on both records’ pages. The decision goes in the audit trail.',
  },
  mapping: {
    title: 'Approve this mapping?',
    description:
      'The mapping is written to the graph as one the AI suggested, with you as its reviewer, and counts toward coverage. The decision goes in the audit trail.',
  },
};

/** Approve, for a waiting link or mapping. `body` holds the ends the Analyst chose; `blocker` says
 * why it can't be approved yet (the button is off until then). */
export function ApproveDialog({
  finding,
  body,
  blocker,
  preview,
  onApproved,
  onStale,
}: {
  finding: FindingDetail;
  body: { from?: string; to?: string };
  blocker: string | null;
  /** What will be written, in plain words. */
  preview: ReactNode;
  onApproved: (decision: Decision) => void;
  /** A refusal that means the page is out of date (decided by someone else, or gone): the dialog
   * closes and the page shows it, as the finding is asked for again. */
  onStale: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const approve = useApproveFinding(finding.id);
  const text = APPROVE_TEXT[finding.kind];
  if (!text) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && approve.isPending) return;
        if (next) {
          approve.reset();
          setNote('');
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" disabled={blocker !== null}>
          <CircleCheck aria-hidden />
          Approve
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (approve.isPending) return;
            approve.mutate(withNote(body, note), {
              onSuccess: (decision) => {
                setOpen(false);
                onApproved(decision);
              },
              onError: (error) => {
                if (!refusalMeansStale(error)) return;
                setOpen(false);
                onStale(error);
              },
            });
          }}
        >
          <div className="bg-muted/40 rounded-md border px-4 py-3 text-sm">{preview}</div>
          <NoteField value={note} onChange={setNote} disabled={approve.isPending} />
          {approve.error ? (
            <ApiProblem
              error={decisionRefusal(approve.error, 'approve', finding.kind)}
              title={decisionRefusalTitle('approve', finding.kind)}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={approve.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={approve.isPending}>
              <CircleCheck aria-hidden />
              {approve.isPending ? 'Approving…' : 'Approve'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const REJECT_TEXT: Record<ReviewFindingKind, { title: string; description: string; button: string; busy: string }> = {
  link: {
    title: 'Reject this link?',
    description: 'The link isn’t written to the graph.',
    button: 'Reject',
    busy: 'Rejecting…',
  },
  record: {
    title: 'Reject this proposed record?',
    description: 'The record isn’t created, and the waiting links that point to it are rejected with it.',
    button: 'Reject',
    busy: 'Rejecting…',
  },
  duplicate: {
    title: 'Mark these as not duplicates?',
    description: 'The two records stay separate, as they are now, and nothing moves between them.',
    button: 'Not duplicates',
    busy: 'Saving…',
  },
  mapping: {
    title: 'Reject this mapping?',
    description: 'The mapping isn’t written and doesn’t count toward coverage.',
    button: 'Reject',
    busy: 'Rejecting…',
  },
};

/** Reject, for any waiting finding, after a confirmation ("Not duplicates" for a possible duplicate). */
export function RejectDialog({
  finding,
  onRejected,
  onStale,
}: {
  finding: FindingDetail;
  onRejected: (decision: Decision) => void;
  /** As for ApproveDialog. */
  onStale: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const reject = useRejectFinding(finding.id);
  const text = REJECT_TEXT[finding.kind];

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && reject.isPending) return;
        if (next) {
          reject.reset();
          setNote('');
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline">
          <CircleX aria-hidden />
          {text.button}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{text.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {text.description} The finding is kept, hidden from the waiting list, and won’t be raised again. The
            decision goes in the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <NoteField value={note} onChange={setNote} disabled={reject.isPending} />
        {reject.error ? (
          <ApiProblem
            error={decisionRefusal(reject.error, 'reject', finding.kind)}
            title={decisionRefusalTitle('reject', finding.kind)}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reject.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={reject.isPending}
            onClick={() => {
              if (reject.isPending) return;
              reject.mutate(withNote({}, note), {
                onSuccess: (decision) => {
                  setOpen(false);
                  onRejected(decision);
                },
                onError: (error) => {
                  if (!refusalMeansStale(error)) return;
                  setOpen(false);
                  onStale(error);
                },
              });
            }}
          >
            <CircleX aria-hidden />
            {reject.isPending ? text.busy : text.button}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
