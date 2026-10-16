// Merging a possible duplicate (S5-006; D24, D43, D51, D69): the Analyst chooses which of the two
// records to keep (the older one, the lower number, to start with, as the API would), then "Merge"
// asks first: the other record is retired, its links and source IDs move to the kept one, the kept
// record takes the higher of the two labels, and it can't be undone. The choice always goes with the
// approval as `keep`, so what the dialog says is what the API does. "Not duplicates" is the
// finding's Reject (./DecisionActions). The API decides (D7) and its refusals show in plain words
// with their reference ID (D47).
import { LABELS, type Label } from '@grc/shared';
import { Merge } from 'lucide-react';
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
import { ApiProblem } from '@/features/records/ApiProblem';
import { LabelBadge } from '@/features/records/LabelBadge';
import { NoteField, withNote } from './DecisionActions';
import { isShown } from './ReviewBits';
import { refusalMeansStale, useApproveFinding, type Decision, type DuplicateFindingDetail } from './useReview';
import { decisionRefusal, decisionRefusalTitle, RECORD_KIND_TEXT } from './words';

type DuplicateRecord = DuplicateFindingDetail['summary']['kept'];
type ShownDuplicate = Extract<DuplicateRecord, { recordId: string }>;

/** The record to keep to start with: the older one, by its lower number (as the API's default). */
export function defaultKeep(finding: DuplicateFindingDetail): string | undefined {
  const { kept, other } = finding.summary;
  if (!isShown(kept) || !isShown(other)) return undefined;
  return kept.number <= other.number ? kept.recordId : other.recordId;
}

/** Why the two can't be merged now, in plain words, or `null` when they can. */
export function mergeBlocker(finding: DuplicateFindingDetail, keep: string | undefined): string | null {
  const { kept, other } = finding.summary;
  if (!isShown(kept) || !isShown(other)) return 'One of the two is a record you can’t see, so you can’t merge them.';
  const retired = [kept, other].find((record) => record.status !== 'active');
  if (retired) return `${retired.number} is retired, so these can’t be merged. Mark them as not duplicates instead.`;
  if (keep !== kept.recordId && keep !== other.recordId) return 'Choose which record to keep.';
  return null;
}

function higherLabel(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Merge, for a waiting possible duplicate whose two records the Analyst can see, after a
 * confirmation that says exactly what happens. */
export function MergeDialog({
  finding,
  keep,
  blocker,
  onMerged,
  onStale,
}: {
  finding: DuplicateFindingDetail;
  keep: string | undefined;
  blocker: string | null;
  onMerged: (decision: Decision) => void;
  /** A refusal that means the page is out of date (decided by someone else, retired, or gone). */
  onStale: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const approve = useApproveFinding(finding.id);
  const { kept, other, recordKind } = finding.summary;
  const pair = isShown(kept) && isShown(other) ? [kept, other] : null;
  const keeping: ShownDuplicate | undefined = pair?.find((record) => record.recordId === keep);
  const retiring: ShownDuplicate | undefined = pair?.find((record) => record.recordId !== keep);
  const noun = RECORD_KIND_TEXT[recordKind].toLowerCase();

  return (
    <AlertDialog
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
      <AlertDialogTrigger asChild>
        <Button type="button" disabled={blocker !== null || !keeping || !retiring}>
          <Merge aria-hidden />
          Merge
        </Button>
      </AlertDialogTrigger>
      {keeping && retiring ? (
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {retiring.number} into {keeping.number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The two {noun}s become one: {keeping.number} “{keeping.name}” is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="grid gap-2 rounded-md border px-4 py-3 text-sm leading-relaxed">
            <li>
              <span className="font-semibold tabular-nums">{retiring.number}</span> is retired, and its page shows it as
              retired, merged into {keeping.number}.
            </li>
            <li>
              {retiring.linkCount === 0
                ? 'It has no links to move.'
                : `Its ${count(retiring.linkCount, 'link moves', 'links move')} to ${keeping.number} (a link ${keeping.number} already has isn’t doubled).`}{' '}
              {retiring.sourceIds.length === 0
                ? 'It has no source IDs to move.'
                : `Its ${count(retiring.sourceIds.length, 'source ID moves', 'source IDs move')} too, so imports from ${retiring.sourceIds.length === 1 ? 'that source' : 'those sources'} find ${keeping.number}.`}
            </li>
            <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>{keeping.number} takes the higher of the two labels:</span>
              <LabelBadge label={higherLabel(keeping.label, retiring.label)} />
            </li>
            <li className="font-semibold">This can’t be undone, here or anywhere else.</li>
          </ul>
          <p className="text-muted-foreground text-sm">The merge and its decision go in the audit trail.</p>
          <NoteField value={note} onChange={setNote} disabled={approve.isPending} />
          {approve.error ? (
            <ApiProblem
              error={decisionRefusal(approve.error, 'approve', 'duplicate')}
              title={decisionRefusalTitle('approve', 'duplicate')}
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.isPending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={approve.isPending}
              onClick={() => {
                if (approve.isPending) return;
                approve.mutate(withNote({ keep: keeping.recordId }, note), {
                  onSuccess: (decision) => {
                    setOpen(false);
                    onMerged(decision);
                  },
                  onError: (error) => {
                    if (!refusalMeansStale(error)) return;
                    setOpen(false);
                    onStale(error);
                  },
                });
              }}
            >
              <Merge aria-hidden />
              {approve.isPending ? 'Merging…' : 'Merge records'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
