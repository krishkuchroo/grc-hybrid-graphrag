// Retire asks first (D69: records are retired, never deleted). The confirm sends the version the
// page shows; a refusal stays in the dialog with the API's message and reference ID.
import { Archive } from 'lucide-react';
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
import { ApiProblem } from './ApiProblem';
import { isStale } from './useRecords';

interface Props {
  /** The record's number, for example RSK0001001. */
  number: string;
  /** "risk", "control"… */
  noun: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => Promise<unknown>;
  onOpenChange?: (open: boolean) => void;
}

export function RetireDialog({ number, noun, pending, error, onConfirm, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline">
          <Archive aria-hidden />
          Retire
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {number}?</AlertDialogTitle>
          <AlertDialogDescription>
            The {noun} leaves the active list but is kept, with its history, in the audit trail. You can still find it
            under the Retired status filter.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <ApiProblem
            error={error}
            title={isStale(error) ? 'This record changed since you opened it' : `The ${noun} wasn't retired`}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              try {
                await onConfirm();
                change(false);
              } catch {
                // The refusal shows in the dialog.
              }
            }}
          >
            {pending ? 'Retiring…' : `Retire ${noun}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
