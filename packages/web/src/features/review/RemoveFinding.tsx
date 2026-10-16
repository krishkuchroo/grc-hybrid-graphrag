// "Remove (false positive)" (S5-006; D38, D69, D207): a fact already live (made live by the rule
// checks, or approved) that turns out false is taken back out. For a link or mapping, the link the
// AI made is deleted from the graph; for an approved new record, the record is retired (records are
// never deleted, D69). It is the only way an AI link ever leaves the graph (D207). Only for the
// Analyst, on the kinds and statuses `canRemove` allows; the dialog says what will happen and that
// it's recorded in the audit trail, and the page then shows what the removal did. The API decides
// (D7) and its refusals show in plain words with their reference ID (D47).
import { Trash2 } from 'lucide-react';
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
import { NoteField, withNote } from './DecisionActions';
import { refusalMeansStale, useRemoveFinding, type FindingDetail, type Removal } from './useReview';
import { decisionRefusal, decisionRefusalTitle, RECORD_KIND_TEXT } from './words';

/** What removing this finding will do in the graph, in plain words. */
function whatHappens(finding: FindingDetail): { title: string; effect: string } {
  switch (finding.kind) {
    case 'link':
    case 'mapping': {
      const what = finding.kind === 'link' ? 'link' : 'mapping';
      if (finding.status === 'approved' && finding.outcome?.result === 'exists') {
        return {
          title: `Remove this ${what} as a false positive?`,
          effect: `The ${what} was already in the graph from elsewhere when this was approved, so it stays there: only the finding is marked removed.`,
        };
      }
      return {
        title: `Remove this ${what} as a false positive?`,
        effect:
          finding.kind === 'link'
            ? 'The link is deleted from the graph and no longer shows on either record’s page.'
            : 'The mapping is deleted from the graph and no longer counts toward coverage.',
      };
    }
    case 'record': {
      const noun = RECORD_KIND_TEXT[finding.summary.recordKind].toLowerCase();
      const number = finding.outcome?.number;
      return {
        title: `Remove this ${noun} as a false positive?`,
        effect: number
          ? `The record ${number} is retired: it leaves the active lists but is kept with its history, and its links stay.`
          : `The record it created is retired: it leaves the active lists but is kept with its history, and its links stay.`,
      };
    }
    case 'duplicate':
      return { title: 'Remove this merge?', effect: 'A merge can’t be undone.' };
  }
}

/** What the removal did, for the page's message. */
export function removalMessage(removal: Removal): string {
  const outcome = removal.outcome;
  if ('result' in outcome) {
    const what = removal.kind === 'mapping' ? 'mapping' : 'link';
    if (outcome.removed?.graph === 'deleted') {
      return `Removed. The ${what} was deleted from the graph. The finding is kept as Removed and won’t be raised again.`;
    }
    return `Removed. The ${what} wasn’t in the graph as one the AI made, so nothing else changed. The finding is kept as Removed and won’t be raised again.`;
  }
  if ('number' in outcome) {
    return outcome.removed?.graph === 'already_retired'
      ? `Removed. ${outcome.number} was already retired. The finding is kept as Removed.`
      : `Removed. ${outcome.number} was retired. The finding is kept as Removed.`;
  }
  return 'Removed.';
}

export function RemoveDialog({
  finding,
  onRemoved,
  onStale,
}: {
  finding: FindingDetail;
  onRemoved: (removal: Removal) => void;
  /** A refusal that means the page is out of date (removed by someone else, or gone). */
  onStale: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const remove = useRemoveFinding(finding.id);
  const text = whatHappens(finding);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && remove.isPending) return;
        if (next) {
          remove.reset();
          setNote('');
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="text-destructive hover:text-destructive">
          <Trash2 aria-hidden />
          Remove (false positive)
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{text.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {text.effect} The finding reads Removed, the AI won’t propose it again, and the removal is recorded in the
            audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <NoteField value={note} onChange={setNote} disabled={remove.isPending} />
        {remove.error ? (
          <ApiProblem
            error={decisionRefusal(remove.error, 'remove', finding.kind)}
            title={decisionRefusalTitle('remove', finding.kind)}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (remove.isPending) return;
              remove.mutate(withNote({}, note), {
                onSuccess: (removal) => {
                  setOpen(false);
                  onRemoved(removal);
                },
                onError: (error) => {
                  if (!refusalMeansStale(error)) return;
                  setOpen(false);
                  onStale(error);
                },
              });
            }}
          >
            <Trash2 aria-hidden />
            {remove.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
