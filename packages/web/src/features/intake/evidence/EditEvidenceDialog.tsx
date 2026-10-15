// Edit on an evidence row (S3-013, D213 (2), (3)): the name, the collected and valid-until dates and
// the label (only the changes `canChangeLabel` allows, nothing above the person's clearance, D51,
// D198). There is no review field, and the file itself isn't changed here: new proof is new
// evidence. Only the fields that changed are sent, with the version the dialog opened, so a stale
// save is refused (409 `stale_version`) and shows S1's message with a way to reload. Shown only when
// the API's `canEdit` is true; the API decides (D7).
import { FileText, Pencil, RefreshCw } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Label } from '@grc/shared';
import type { PatchEvidenceIdBody } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { Viewer } from '@/features/records/permissions';
import { FORMAT_TEXT, formatBytes } from '../permissions';
import { EvidenceFields, EvidenceRefusal } from './AddEvidenceDialog';
import {
  editEvidenceLabelChoices,
  evidenceFieldProblems,
  evidenceProblem,
  localToday,
  useRefreshEvidence,
  useReloadEvidence,
  useUpdateEvidence,
  type Evidence,
  type EvidenceFieldValues,
} from './useEvidence';

function valuesOf(item: Evidence): EvidenceFieldValues {
  return {
    name: item.name,
    collectedDate: item.collectedDate,
    validUntil: item.validUntil ?? '',
    label: item.label,
  };
}

/** Only what changed from the stored item, as the API takes it; an emptied valid-until is `null`. */
export function evidenceChanges(item: Evidence, values: EvidenceFieldValues): Omit<PatchEvidenceIdBody, 'version'> {
  const changes: Omit<PatchEvidenceIdBody, 'version'> = {};
  const name = values.name.trim();
  if (name !== item.name) changes.name = name;
  const collected = values.collectedDate.trim();
  if (collected !== item.collectedDate) changes.collectedDate = collected;
  const until = values.validUntil.trim() === '' ? null : values.validUntil.trim();
  if (until !== (item.validUntil ?? null)) changes.validUntil = until;
  if (values.label !== item.label) changes.label = values.label as Label;
  return changes;
}

function EditEvidenceForm({
  item,
  viewer,
  update,
  notice,
  onCancel,
  onSave,
}: {
  item: Evidence;
  viewer: Viewer;
  update: ReturnType<typeof useUpdateEvidence>;
  notice: ReactNode;
  onCancel: () => void;
  onSave: (body: PatchEvidenceIdBody | null) => void;
}) {
  const [values, setValues] = useState<EvidenceFieldValues>(() => valuesOf(item));
  const [tried, setTried] = useState(false);
  const errors = tried ? evidenceFieldProblems(values, localToday()) : {};
  const pending = update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (pending) return;
    if (Object.keys(evidenceFieldProblems(values, localToday())).length > 0) return;
    const changes = evidenceChanges(item, values);
    onSave(Object.keys(changes).length === 0 ? null : { ...changes, version: item.version });
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-5">
      {notice}
      <div className="bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2.5">
        <FileText className="text-primary size-4 shrink-0" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="truncate font-semibold" title={item.fileName}>
            {item.fileName}
          </p>
          <p className="text-muted-foreground text-xs">
            {FORMAT_TEXT[item.format]} file, {formatBytes(item.sizeBytes)}. To replace the file, add new evidence and
            retire this one.
          </p>
        </div>
      </div>

      <EvidenceFields
        values={values}
        errors={errors}
        labelChoices={editEvidenceLabelChoices(viewer, item.label)}
        disabled={pending}
        clearance={viewer.clearance}
        onChange={(next) => setValues((v) => ({ ...v, ...next }))}
      />

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditEvidenceDialog({
  item,
  controlId,
  viewer,
  onSaved,
}: {
  item: Evidence;
  /** The control whose page lists it. */
  controlId: string;
  viewer: Viewer;
  /** Called with the saved evidence. */
  onSaved?: (item: Evidence) => void;
}) {
  const [open, setOpen] = useState(false);
  /** The item the form started from: the row's copy, or the latest after a stale save's reload. */
  const [base, setBase] = useState<Evidence>(item);
  /** A new form each time it opens or reloads. */
  const [round, setRound] = useState(0);
  const [reloadError, setReloadError] = useState<unknown>(null);
  const [reloading, setReloading] = useState(false);
  const update = useUpdateEvidence(controlId, item.id);
  const reload = useReloadEvidence(controlId);
  const refresh = useRefreshEvidence(controlId);

  const error = update.error ?? reloadError;
  let notice: ReactNode = null;
  if (error) {
    const problem = evidenceProblem(error, 'edit');
    notice = (
      <EvidenceRefusal error={error} action="edit">
        {problem.stale && error === update.error ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-1"
            disabled={reloading}
            onClick={async () => {
              setReloading(true);
              try {
                const latest = await reload(item.id);
                update.reset();
                setReloadError(null);
                setBase(latest);
                setRound((r) => r + 1);
              } catch (err) {
                update.reset();
                setReloadError(err);
              } finally {
                setReloading(false);
              }
            }}
          >
            <RefreshCw aria-hidden />
            {reloading ? 'Reloading…' : 'Reload latest version'}
          </Button>
        ) : null}
      </EvidenceRefusal>
    );
  }

  /** Closing after a "gone" refusal asks for the list again, so the row leaves once the message is read. */
  const change = (next: boolean) => {
    if (update.isPending) return;
    if (next) {
      update.reset();
      setReloadError(null);
      setBase(item);
      setRound((r) => r + 1);
    } else if (error && evidenceProblem(error, 'edit').gone) {
      void refresh();
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Edit ${item.number}`}
          title={`Edit ${item.number}`}
        >
          <Pencil aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="text-primary size-4" aria-hidden />
            Edit {base.number}
          </DialogTitle>
          <DialogDescription>
            Change the evidence’s name, dates or label. Fields marked * are required.
          </DialogDescription>
        </DialogHeader>
        <EditEvidenceForm
          key={round}
          item={base}
          viewer={viewer}
          update={update}
          notice={notice}
          onCancel={() => change(false)}
          onSave={(body) => {
            if (body === null) {
              change(false);
              return;
            }
            update.mutate(body, {
              onSuccess: (saved) => {
                setOpen(false);
                onSaved?.(saved);
              },
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
