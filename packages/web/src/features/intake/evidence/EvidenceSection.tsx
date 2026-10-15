// "Evidence" on a control page (S3-013, D213 (2)-(4), R13): the active evidence supporting the
// control, from GET /api/v1/controls/:id/evidence, in a ServiceNow related list (D2). Each row has
// the number and name (with the file), the collected date, the valid-until date, a validity badge
// (from the API's `validity`: Valid, Expiring soon, Expired), the review status in plain words with
// the reviewer and date when there is one, the label, and Download. Edit and Retire show per row only
// when the API's `canEdit` is true. "Add evidence" shows only when `canAddEvidence` holds for this
// control. A role that never sees evidence (the Viewer) gets no section, and a control whose evidence
// the API hides (404) shows none either: only what the API returns is shown (D51). The API decides
// (D7). Evidence supports controls only (D67), so no other record page has this section.
import { Archive, CircleCheck, Download, LoaderCircle } from 'lucide-react';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatDate, formatDay } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import type { Viewer } from '@/features/records/permissions';
import { isNotFound, useMe, type AnyRecord } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { FORMAT_TEXT, formatBytes } from '../permissions';
import { AddEvidenceDialog, EvidenceRefusal } from './AddEvidenceDialog';
import { EditEvidenceDialog } from './EditEvidenceDialog';
import {
  evidenceProblem,
  localToday,
  mayAddEvidence,
  mayChangeEvidence,
  mayViewEvidence,
  reviewText,
  useControlEvidence,
  useDownloadEvidence,
  useRefreshEvidence,
  useRetireEvidence,
  validUntilHint,
  type Evidence,
} from './useEvidence';
import { ValidityBadge } from './ValidityBadge';

const REVIEW_DOT: Record<string, string> = {
  pending: 'bg-[#2b6cb0]',
  accepted: 'bg-[#2f8a55]',
  rejected: 'bg-[#b42318]',
};

/** The review status as a state indicator, with who reviewed it and when (D213 (2)). */
export function ReviewStatus({ item }: { item: Pick<Evidence, 'reviewStatus' | 'reviewer' | 'reviewedAt'> }) {
  return (
    <span className="grid gap-0.5">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span
          className={cn('size-2 shrink-0 rounded-full', REVIEW_DOT[item.reviewStatus] ?? 'bg-[#8a969c]')}
          aria-hidden
        />
        <span>{reviewText(item.reviewStatus)}</span>
      </span>
      {item.reviewer ? (
        <span className="text-muted-foreground text-xs">
          by {item.reviewer.name}
          {item.reviewedAt ? `, ${formatDay(item.reviewedAt)}` : ''}
        </span>
      ) : null}
    </span>
  );
}

/** The person as the access rules take them, or `null` until the shell has asked. */
function useViewer(): Viewer | null {
  const me = useMe();
  return me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
}

function DownloadButton({ item, onError }: { item: Evidence; onError: (err: unknown) => void }) {
  const download = useDownloadEvidence();
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-8"
      aria-label={`Download ${item.fileName}`}
      title={`Download ${item.fileName}`}
      disabled={download.isPending}
      onClick={() => download.mutate(item, { onError })}
    >
      {download.isPending ? <LoaderCircle className="animate-spin" aria-hidden /> : <Download aria-hidden />}
    </Button>
  );
}

/** Retire asks first (D69: never deleted). The confirm sends the version the row shows. */
function RetireEvidenceButton({ item, controlId }: { item: Evidence; controlId: string }) {
  const [open, setOpen] = useState(false);
  const retire = useRetireEvidence(controlId, item.id);
  const refresh = useRefreshEvidence(controlId);

  const change = (next: boolean) => {
    if (retire.isPending) return;
    if (next) retire.reset();
    else if (retire.error && evidenceProblem(retire.error, 'retire').gone) void refresh();
    setOpen(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Retire ${item.number}`}
          title={`Retire ${item.number}`}
        >
          <Archive aria-hidden />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {item.number}?</AlertDialogTitle>
          <AlertDialogDescription>
            {item.name} leaves this control’s evidence list. It isn’t deleted: the evidence, its file and its history
            are kept in the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {retire.error ? <EvidenceRefusal error={retire.error} action="retire" /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={retire.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={retire.isPending}
            onClick={() =>
              retire.mutate(item.version, {
                onSuccess: () => setOpen(false),
                // A stale retire: the list asks again, so the next try sends the latest version.
                onError: (err) => {
                  if (evidenceProblem(err, 'retire').stale) void refresh();
                },
              })
            }
          >
            {retire.isPending ? 'Retiring…' : 'Retire evidence'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EvidenceSection({ control }: { control: AnyRecord }) {
  const title = 'Evidence';
  const viewer = useViewer();
  const visible = mayViewEvidence(viewer);
  const query = useControlEvidence(control.id, visible);
  const [added, setAdded] = useState<Evidence | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  // The Viewer never sees evidence (D50); a control whose evidence is hidden shows nothing either.
  if (!viewer || !visible) return null;
  if (query.isError && isNotFound(query.error)) return null;

  const today = localToday();
  const items = query.data ?? [];
  const mayAdd = mayAddEvidence(viewer, control);
  const anyChangeable = items.some(mayChangeEvidence);

  return (
    <section aria-label={title} className="bg-card rounded-lg border shadow-xs">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-1.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {query.data ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {items.length}
            </span>
          ) : null}
        </h2>
        <p role="status" className="text-muted-foreground flex min-w-0 items-center text-xs">
          {added ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              <span className="truncate">
                <span className="text-foreground font-semibold tabular-nums">{added.number}</span> was added and is
                pending review.
              </span>
            </span>
          ) : null}
        </p>
        {mayAdd ? (
          <div className="ml-auto">
            <AddEvidenceDialog
              control={control}
              viewer={viewer}
              onAdded={(item) => {
                setDownloadError(null);
                setAdded(item);
              }}
            />
          </div>
        ) : null}
      </div>

      {downloadError ? (
        <div className="border-b p-4">
          <EvidenceRefusal error={downloadError} action="download">
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => setDownloadError(null)}>
              Dismiss
            </Button>
          </EvidenceRefusal>
        </div>
      ) : null}

      {query.isPending ? (
        <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading the evidence…</span>
        </div>
      ) : query.isError ? (
        <div className="p-4">
          <ApiProblem error={query.error} title="The evidence couldn’t be loaded">
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </ApiProblem>
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground grid gap-1 px-5 py-5 text-sm">
          <p>No evidence supports this control yet.</p>
          {mayAdd ? <p className="text-xs">Use Add evidence to attach a file that shows the control works.</p> : null}
        </div>
      ) : (
        <Table aria-label={`Evidence for ${control.number}`}>
          <TableHeader>
            <TableRow className="text-muted-foreground">
              <TableHead className="pl-5">
                Number <span className="font-normal">and name</span>
              </TableHead>
              <TableHead className="w-28">Collected</TableHead>
              <TableHead className="w-32">Valid until</TableHead>
              <TableHead className="w-32">Validity</TableHead>
              <TableHead className="w-40">Review status</TableHead>
              <TableHead className="w-28">Label</TableHead>
              <TableHead className={cn('pr-5 text-right', anyChangeable ? 'w-32' : 'w-16')}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} className="hover:bg-muted/40">
                <TableCell className="max-w-0 min-w-56 py-1.5 pl-5">
                  <span className="font-semibold tabular-nums">{item.number}</span>
                  <span className="block truncate" title={item.name}>
                    {item.name}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs" title={item.fileName}>
                    {item.fileName} ({FORMAT_TEXT[item.format] ?? item.format}, {formatBytes(item.sizeBytes)})
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(item.collectedDate)}</TableCell>
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="whitespace-nowrap">{item.validUntil ? formatDate(item.validUntil) : '—'}</span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {validUntilHint(item.validUntil, today)}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <ValidityBadge validity={item.validity} />
                </TableCell>
                <TableCell>
                  <ReviewStatus item={item} />
                </TableCell>
                <TableCell>
                  <LabelBadge label={item.label} />
                </TableCell>
                <TableCell className="pr-5">
                  <div className="flex items-center justify-end gap-0.5">
                    <DownloadButton item={item} onError={setDownloadError} />
                    {mayChangeEvidence(item) ? (
                      <>
                        <EditEvidenceDialog item={item} controlId={control.id} viewer={viewer} />
                        <RetireEvidenceButton item={item} controlId={control.id} />
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
