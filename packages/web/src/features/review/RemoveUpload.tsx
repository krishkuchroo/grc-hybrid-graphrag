// "Remove everything from this upload" (S5-006; D38, D52.5, D69, D207): one bad upload taken back
// out in a single action. The impact (S5-004's counts: the live AI links from it in the graph, the
// records approved from it, its waiting findings and its live or approved ones) shows to the Admin
// and the Analyst alike, on a finding's source section and above the queue when it is narrowed to
// one document. Only the Analyst gets the button. Its confirmation names the document and its
// uploader, shows the counts, and needs "I understand this can't be undone" ticked; afterwards it
// shows what was removed, and the document reads Removed (here and in Data intake) and its findings
// Rejected or Removed. The counts include what is above the Analyst's clearance, as numbers only
// (planner's reading S5-Q1). The API decides (D7) and its refusals show in plain words with their
// reference ID (D47).
import { CircleCheck, FileText, Trash2 } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Label as FieldLabel } from '@/components/ui/label';
import { KIND_TEXT } from '@/features/intake/permissions';
import { StatusBadge as DocumentStatusBadge } from '@/features/intake/StatusBadge';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { cn } from '@/lib/utils';
import { NoteField, withNote } from './DecisionActions';
import { Panel } from './ReviewBits';
import { useRemoveUpload, useUploadImpact, type UploadImpact, type UploadRemoval } from './useReview';
import { decisionRefusal, decisionRefusalTitle, textOrNull } from './words';

type Uploader = UploadImpact['document']['uploader'];

export function uploaderText(uploader: Uploader): string {
  if (uploader.type === 'api_key') return textOrNull(uploader.name) ?? 'An API key';
  if (uploader.type === 'system') return 'The system (sample data)';
  return textOrNull(uploader.name) ?? 'A former member';
}

function n(value: number): string {
  return value.toLocaleString('en-US');
}

/** The impact counts, each with what removing the upload does to it. */
const IMPACT_ROWS: ReadonlyArray<{
  key: keyof UploadImpact['counts'];
  label: string;
  effect: (count: number) => string;
}> = [
  {
    key: 'liveAiLinks',
    label: 'Live AI links in the graph',
    effect: (c) => `${n(c)} live AI ${c === 1 ? 'link is' : 'links are'} deleted from the graph.`,
  },
  {
    key: 'approvedRecords',
    label: 'Records approved from it',
    effect: (c) => `${n(c)} ${c === 1 ? 'record' : 'records'} approved from it ${c === 1 ? 'is' : 'are'} retired.`,
  },
  {
    key: 'pendingFindings',
    label: 'Waiting findings',
    effect: (c) => `${n(c)} waiting ${c === 1 ? 'finding is' : 'findings are'} rejected.`,
  },
  {
    key: 'liveOrApprovedFindings',
    label: 'Live or approved findings',
    effect: (c) => `${n(c)} live or approved ${c === 1 ? 'finding is' : 'findings are'} removed.`,
  },
];

/** What the removal did, each count in words. */
const REMOVED_ROWS: ReadonlyArray<{ key: keyof UploadRemoval['counts']; text: (count: number) => string }> = [
  { key: 'aiLinksDeleted', text: (c) => `${n(c)} AI ${c === 1 ? 'link' : 'links'} deleted from the graph` },
  { key: 'recordsRetired', text: (c) => `${n(c)} approved ${c === 1 ? 'record' : 'records'} retired` },
  { key: 'findingsRejected', text: (c) => `${n(c)} waiting ${c === 1 ? 'finding' : 'findings'} rejected` },
  { key: 'findingsRemoved', text: (c) => `${n(c)} live or approved ${c === 1 ? 'finding' : 'findings'} removed` },
  {
    key: 'chunkRecordsDeleted',
    text: (c) => `${n(c)} ${c === 1 ? 'passage' : 'passages'} no longer tied to a record`,
  },
];

/** The four counts, side by side. */
function ImpactCounts({ counts, className }: { counts: UploadImpact['counts']; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-4', className)}>
      {IMPACT_ROWS.map((row) => (
        <div key={row.key} className="bg-card grid content-start gap-0.5 px-3 py-2.5">
          <dt className="text-muted-foreground text-xs font-semibold">{row.label}</dt>
          <dd className="text-lg leading-tight font-semibold tabular-nums">{n(counts[row.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentLine({ document }: { document: UploadImpact['document'] }) {
  return (
    <div className="grid gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="font-semibold [overflow-wrap:anywhere]">{document.name}</span>
        <span className="text-muted-foreground text-xs">{KIND_TEXT[document.kind]}</span>
        <LabelBadge label={document.label} />
        <DocumentStatusBadge documentStatus={document.status} />
      </p>
      <p className="text-muted-foreground">
        Uploaded by {uploaderText(document.uploader)}, {formatMoment(document.uploadedAt)}
      </p>
    </div>
  );
}

/** Remove everything from one upload, after a confirmation; then what it did. */
function RemoveUploadDialog({ impact, onOpen }: { impact: UploadImpact; onOpen: () => void }) {
  const checkId = useId();
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<UploadRemoval | null>(null);
  const remove = useRemoveUpload(impact.document.id);
  const document = impact.document;
  const nothingLeft = done !== null && REMOVED_ROWS.every((row) => done.counts[row.key] === 0);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && remove.isPending) return;
        if (next) {
          remove.reset();
          setNote('');
          setUnderstood(false);
          setDone(null);
          onOpen();
        }
        setOpen(next);
      }}
    >
      {/* Once the upload is removed the button goes, but an open dialog stays to show the result. */}
      {document.status !== 'removed' ? (
        <AlertDialogTrigger asChild>
          <Button type="button" variant="outline" className="text-destructive hover:text-destructive">
            <Trash2 aria-hidden />
            Remove everything from this upload
          </Button>
        </AlertDialogTrigger>
      ) : null}
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        {done ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <CircleCheck className="size-5 text-[#2f8a55]" aria-hidden />
                {nothingLeft ? 'Nothing was left to remove' : 'Everything from this upload was removed'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {nothingLeft
                  ? 'This upload had already been removed, so this run changed nothing.'
                  : 'The upload now reads Removed in Data intake and won’t be processed again, and its findings read Rejected or Removed. The removal is recorded in the audit trail.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <DocumentLine document={{ ...document, status: 'removed' }} />
            <ul className="grid gap-1.5 rounded-md border px-4 py-3 text-sm">
              {REMOVED_ROWS.map((row) => (
                <li key={row.key} className={cn(done.counts[row.key] === 0 && 'text-muted-foreground')}>
                  {row.text(done.counts[row.key])}
                </li>
              ))}
            </ul>
            <AlertDialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove everything from this upload?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything the AI took from this document comes back out of the graph and the queue, in one step.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="bg-muted/40 rounded-md border px-4 py-3">
              <DocumentLine document={document} />
            </div>
            <div className="grid gap-2">
              <ul className="grid gap-2 rounded-md border px-4 py-3 text-sm leading-relaxed">
                {IMPACT_ROWS.map((row) => (
                  <li key={row.key} className={cn(impact.counts[row.key] === 0 && 'text-muted-foreground')}>
                    {row.effect(impact.counts[row.key])}
                  </li>
                ))}
                <li>
                  The upload reads Removed in Data intake and is never processed again. The stored file is kept, and
                  uploading the same file again doesn’t bring it back.
                </li>
              </ul>
              <p className="text-muted-foreground text-xs">
                The counts include anything above your clearance, as numbers only.
              </p>
            </div>
            <NoteField value={note} onChange={setNote} disabled={remove.isPending} />
            <div className="flex items-start gap-2.5 rounded-md border border-[#e2b0ab] bg-[#fcefed] px-3 py-2.5">
              <Checkbox
                id={checkId}
                checked={understood}
                disabled={remove.isPending}
                onCheckedChange={(value) => setUnderstood(value === true)}
                className="mt-0.5"
              />
              <FieldLabel htmlFor={checkId} className="text-sm leading-snug font-semibold text-[#8f1f15]">
                I understand this can’t be undone
              </FieldLabel>
            </div>
            {remove.error ? (
              <ApiProblem
                error={decisionRefusal(remove.error, 'remove_upload')}
                title={decisionRefusalTitle('remove_upload')}
              />
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={!understood || remove.isPending}
                onClick={() => {
                  if (!understood || remove.isPending) return;
                  remove.mutate(withNote({}, note), { onSuccess: (result) => setDone(result) });
                }}
              >
                <Trash2 aria-hidden />
                {remove.isPending ? 'Removing…' : 'Remove everything'}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The upload's counts and, for the Analyst, the way to remove all of it. Nothing shows when the
 * reader may not see the document. `framed` shows the document itself in its own panel (above the
 * queue); otherwise it's a section of the finding's source panel, which names the document already. */
export function UploadImpactSection({
  documentId,
  canRemove,
  framed = false,
}: {
  documentId: string;
  /** The Analyst (Review-queue `work`); the Admin sees the counts only. */
  canRemove: boolean;
  framed?: boolean;
}) {
  const query = useUploadImpact(documentId, true);
  const impact = query.data;
  if (query.isPending) {
    return framed ? null : (
      <p className="text-muted-foreground border-t px-5 py-3 text-xs" role="status">
        Counting what this upload put in…
      </p>
    );
  }
  if (query.isError && impact === undefined) {
    const problem = <ApiProblem error={query.error} title="What this upload put in couldn’t be counted" />;
    return framed ? problem : <div className="border-t px-5 py-4">{problem}</div>;
  }
  if (!impact) return null;

  const removed = impact.document.status === 'removed';
  const action: ReactNode = (
    <>
      {removed ? (
        <p className="text-muted-foreground text-sm">
          This upload was removed: nothing the AI took from it is in the graph, and it won’t be processed again.
        </p>
      ) : null}
      {/* Mounted while the upload is removed too, so its result stays on screen. */}
      {canRemove ? <RemoveUploadDialog impact={impact} onOpen={() => void query.refetch()} /> : null}
    </>
  );

  const body = (
    <div className="grid gap-3">
      <ImpactCounts counts={impact.counts} />
      {removed || canRemove ? <div className="flex flex-wrap items-center gap-3">{action}</div> : null}
    </div>
  );

  if (framed) {
    return (
      <Panel title="This upload" icon={FileText}>
        <div className="grid gap-4 px-5 py-4">
          <DocumentLine document={impact.document} />
          {body}
        </div>
      </Panel>
    );
  }
  return (
    <div className="grid gap-3 border-t px-5 py-4">
      <h3 className="text-xs font-semibold">What this upload put in</h3>
      {body}
    </div>
  );
}
