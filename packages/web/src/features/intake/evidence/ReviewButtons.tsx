// "Accept" and "Reject" on an evidence row of the control page (S3-022, D213 (2), D220 (4)). Shown
// only when the API's `canReview` is true (an Admin or a Compliance Manager who sees the evidence and
// didn't add it); the API checks again and decides (D7). Each asks for confirmation, then sends the
// decision with the version the row shows to POST /api/v1/evidence/:id/review. The answer replaces
// the row, which then shows "Accepted" or "Rejected" with the reviewer's name and date. A stale
// decision (409 `stale_version`) asks for the list again, so the next try sends the latest version;
// a 404 asks again once the message is closed, so the row leaves.
import { Check, FileText, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
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
import { formatDate, formatDay } from '@/features/records/format';
import { cn } from '@/lib/utils';
import { FORMAT_TEXT, formatBytes } from '../permissions';
import { EvidenceRefusal } from './AddEvidenceDialog';
import {
  evidenceProblem,
  reviewText,
  useRefreshEvidence,
  useReviewEvidence,
  type Evidence,
  type EvidenceDecision,
} from './useEvidence';
import { ValidityBadge } from './ValidityBadge';

interface DecisionLook {
  /** The trigger's words, and the start of its accessible name. */
  verb: string;
  /** The confirm button's words, and what it says while the decision is on its way. */
  confirm: string;
  pending: string;
  action: 'accept' | 'reject';
  icon: LucideIcon;
  /** The trigger's tone, matching the review status colours (green accepted, red rejected). */
  tone: string;
  /** What the decision means, in the reviewer's words. */
  meaning: (name: string) => string;
}

const LOOK: Record<EvidenceDecision, DecisionLook> = {
  accepted: {
    verb: 'Accept',
    confirm: 'Accept evidence',
    pending: 'Accepting…',
    action: 'accept',
    icon: Check,
    tone: 'border-[#b9d3c4] text-[#23553a] hover:bg-[#eef6f1] hover:text-[#1b4630]',
    meaning: (name) => `You’re confirming that ${name} shows this control works.`,
  },
  rejected: {
    verb: 'Reject',
    confirm: 'Reject evidence',
    pending: 'Rejecting…',
    action: 'reject',
    icon: X,
    tone: 'border-[#e2b0ab] text-[#8f1f15] hover:bg-[#fcefed] hover:text-[#7a1a12]',
    meaning: (name) => `You’re marking ${name} as not enough to show this control works.`,
  },
};

/** The item as the reviewer is about to judge it: its file, dates and validity, and the decision it
 * already has, if any. */
function EvidenceSummary({ item }: { item: Evidence }) {
  return (
    <div className="bg-muted/50 grid gap-2 rounded-md border px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-start gap-2.5">
        <FileText className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="truncate font-semibold" title={item.name}>
            <span className="tabular-nums">{item.number}</span> {item.name}
          </p>
          <p className="text-muted-foreground truncate text-xs" title={item.fileName}>
            {item.fileName} ({FORMAT_TEXT[item.format] ?? item.format}, {formatBytes(item.sizeBytes)})
          </p>
        </div>
      </div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-xs">
        <dt>Collected</dt>
        <dd className="text-foreground">{formatDate(item.collectedDate)}</dd>
        <dt>Valid until</dt>
        <dd className="text-foreground flex flex-wrap items-center gap-2">
          <span>{item.validUntil ? formatDate(item.validUntil) : 'No end date'}</span>
          <ValidityBadge validity={item.validity} />
        </dd>
        <dt>Review status</dt>
        <dd className="text-foreground">
          {reviewText(item.reviewStatus)}
          {item.reviewer ? (
            <span className="text-muted-foreground">
              {' '}
              by {item.reviewer.name}
              {item.reviewedAt ? `, ${formatDay(item.reviewedAt)}` : ''}
            </span>
          ) : null}
        </dd>
      </dl>
    </div>
  );
}

function ReviewButton({
  item,
  controlId,
  decision,
  onReviewed,
}: {
  item: Evidence;
  controlId: string;
  decision: EvidenceDecision;
  onReviewed?: (item: Evidence) => void;
}) {
  const look = LOOK[decision];
  const Icon = look.icon;
  const [open, setOpen] = useState(false);
  const review = useReviewEvidence(controlId, item.id);
  const refresh = useRefreshEvidence(controlId);

  const change = (next: boolean) => {
    if (review.isPending) return;
    if (next) review.reset();
    else if (review.error && evidenceProblem(review.error, look.action).gone) void refresh();
    setOpen(next);
  };

  const replaces = item.reviewStatus !== 'pending' && item.reviewer !== null;

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('h-7 gap-1 px-2 text-xs has-[>svg]:px-2', look.tone)}
          aria-label={`${look.verb} ${item.number}`}
          title={`${look.verb} ${item.number}`}
        >
          <Icon className="size-3.5" aria-hidden />
          {look.verb}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {look.verb} {item.number}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              <p>
                {look.meaning(item.name)} The row will show {reviewText(decision)} with your name and today’s date, and
                the decision is kept in the audit trail.
              </p>
              {replaces && item.reviewer ? (
                <p>
                  It was {reviewText(item.reviewStatus).toLowerCase()} by {item.reviewer.name}
                  {item.reviewedAt ? ` on ${formatDay(item.reviewedAt)}` : ''}. Your decision replaces that one.
                </p>
              ) : null}
              <p>If someone edits this evidence later, it goes back to pending review.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <EvidenceSummary item={item} />
        {review.error ? <EvidenceRefusal error={review.error} action={look.action} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={review.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant={decision === 'rejected' ? 'destructive' : 'default'}
            disabled={review.isPending}
            onClick={() =>
              review.mutate(
                { decision, version: item.version },
                {
                  onSuccess: (saved) => {
                    setOpen(false);
                    onReviewed?.(saved);
                  },
                  // A stale decision: the list asks again, so the next try sends the latest version.
                  onError: (err) => {
                    if (evidenceProblem(err, look.action).stale) void refresh();
                  },
                },
              )
            }
          >
            <Icon aria-hidden />
            {review.isPending ? look.pending : look.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Accept and Reject for one evidence row. The caller shows them only when `mayReviewEvidence`
 * holds (the API's `canReview`). */
export function ReviewButtons({
  item,
  controlId,
  onReviewed,
  className,
}: {
  item: Evidence;
  /** The control whose page lists it. */
  controlId: string;
  /** Called with the reviewed evidence, as the API answered. */
  onReviewed?: (item: Evidence) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={`Review ${item.number}`} className={cn('flex items-center gap-1', className)}>
      <ReviewButton item={item} controlId={controlId} decision="accepted" {...(onReviewed ? { onReviewed } : {})} />
      <ReviewButton item={item} controlId={controlId} decision="rejected" {...(onReviewed ? { onReviewed } : {})} />
    </div>
  );
}
