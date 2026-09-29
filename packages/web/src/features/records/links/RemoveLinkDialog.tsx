// "Remove" on a related-records row (D201): the confirmation names the link in plain words and says
// the removal is recorded in the audit trail. The web only offers it where the API would accept it
// (D200, D207); the API decides (D7), so its refusals show on the page in plain words.
import { Ban, SearchX, Sparkles, Unlink } from 'lucide-react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '../ApiProblem';
import type { RecordLink } from './useLinks';

/** The row being removed, kept as it was when "Remove" was pressed. */
export interface RemovalTarget {
  /** The group's plain title, for example "Controls that treat this risk". */
  groupTitle: string;
  link: RecordLink;
}

export const LINK_GONE_TEXT = 'This link no longer exists or you can’t see it.';
export const AI_LINK_TEXT = "This link was found by the AI. It can only be removed through the Analyst's review.";

function ReferenceId({ id }: { id: string | undefined }) {
  return id ? (
    <p className="text-xs">
      Reference ID <span className="font-semibold select-all">{id}</span>
    </p>
  ) : null;
}

/** The API's refusal of a removal, in the page's own words where the brief gives them. */
export function RemovalRefusal({ error, subject }: { error: unknown; subject: string }) {
  const title = `The link to ${subject} wasn’t removed`;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Alert variant="destructive" role="alert">
        <SearchX aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>{LINK_GONE_TEXT}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (error instanceof ApiError && error.code === 'ai_link_review_only') {
    return (
      <Alert role="alert">
        <Sparkles aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>{AI_LINK_TEXT}</p>
          <ReferenceId id={error.referenceId} />
        </AlertDescription>
      </Alert>
    );
  }
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Alert variant="destructive" role="alert">
        <Ban aria-hidden />
        <AlertTitle>You can’t remove this link</AlertTitle>
        <AlertDescription>
          <p>Only someone who can edit one of the two records may remove the link between them.</p>
          <ReferenceId id={error.referenceId} />
        </AlertDescription>
      </Alert>
    );
  }
  return <ApiProblem error={error} title={title} />;
}

export function RemoveLinkDialog({
  target,
  pending,
  onConfirm,
  onCancel,
}: {
  target: RemovalTarget | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const other = target?.link.other;
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Unlink className="text-destructive size-4" aria-hidden />
            Remove this link?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-3">
              {target && other ? (
                <div className="bg-muted/40 text-foreground rounded-md border px-3 py-2.5">
                  <p className="text-muted-foreground text-xs font-medium">{target.groupTitle}</p>
                  <p className="mt-0.5 text-sm">
                    <span className="font-semibold tabular-nums">{other.number}</span> {other.name}
                  </p>
                </div>
              ) : null}
              <p>
                Both records stay as they are; only the link between them goes. The removal is recorded in the audit
                trail with your name.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            <Unlink aria-hidden />
            {pending ? 'Removing…' : 'Remove link'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
