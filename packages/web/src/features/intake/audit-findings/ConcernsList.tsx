// "Controls and risks it concerns" on a finding's page (D67 CONCERNS, D213 (2)): what GET
// /api/v1/audit-findings/:id/concerns returns (only records the person can see, D51), each row
// linking to that control's or risk's page. "Link a control or risk" shows when the person could
// link one (`canLinkFinding`, D200), and "Remove" on a row when they could link that record and the
// link isn't one the AI found (`isRemovableLinkOrigin`, D201, D207). A finding keeps at least one
// concern (R11): the API's 409 `last_concern` shows in plain words. The API decides (D7).
import type { Label } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { Ban, Check, CircleCheck, Link2, Plus, Search, SearchX, Sparkles, Unlink } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label as FieldLabel } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem, NOT_FOUND_TEXT } from '@/features/records/ApiProblem';
import { LabelBadge } from '@/features/records/LabelBadge';
import { AI_LINK_TEXT, LINK_GONE_TEXT } from '@/features/records/links/RemoveLinkDialog';
import { useLinkSearch } from '@/features/records/links/useLinks';
import type { Viewer } from '@/features/records/permissions';
import { StatusBadge } from '@/features/records/RecordPage';
import { cn } from '@/lib/utils';
import {
  CONCERN_KINDS,
  isLastConcern,
  KIND_NOUN,
  LAST_CONCERN_TEXT,
  mayLinkAny,
  mayLinkTo,
  mayRemoveConcern,
  useAddConcern,
  useFindingConcerns,
  useRemoveConcern,
  type Concern,
  type ConcernKind,
  type Finding,
} from './useFindings';

/** How long typing must pause before the search is asked. */
const SEARCH_PAUSE_MS = 200;

const PLURAL: Record<ConcernKind, string> = { control: 'controls', risk: 'risks' };
const KIND_TITLE: Record<ConcernKind, string> = { control: 'Control', risk: 'Risk' };
const ORIGIN_TEXT: Record<string, string> = { manual: 'Manual', import: 'Import', ai: 'AI' };

/** The link to a control's or risk's page, by its number. */
function ConcernNumberLink({ kind, id, number }: { kind: ConcernKind; id: string; number: string }) {
  return (
    <Link
      to={kind === 'control' ? '/controls/$id' : '/risks/$id'}
      params={{ id }}
      className="text-primary font-semibold tabular-nums underline-offset-2 hover:underline"
    >
      {number}
    </Link>
  );
}

/** A link's origin as a small tag; an AI link says it is changed only through review. */
function ConcernOrigin({ origin }: { origin: string }) {
  const label = ORIGIN_TEXT[origin] ?? origin;
  if (origin === 'ai') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sm border border-[#c9c2e6] bg-[#f3f1fb] px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap text-[#4a3d8f]"
        title="Found by the AI. It is changed only through the Analyst's review."
      >
        <Sparkles className="size-3" aria-hidden />
        {label}
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs whitespace-nowrap">{label}</span>;
}

function ReferenceId({ id }: { id: string | undefined }) {
  return id ? (
    <p className="text-xs">
      Reference ID <span className="font-semibold select-all">{id}</span>
    </p>
  ) : null;
}

/** The API's refusal of a removal, in the page's own words. */
function RemovalRefusal({ error, subject }: { error: unknown; subject: string }) {
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
  if (isLastConcern(error)) {
    return (
      <Alert variant="destructive" role="alert">
        <Ban aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>{LAST_CONCERN_TEXT}</p>
          <p>Link another control or risk first, then remove this one.</p>
          <ReferenceId id={(error as ApiError).referenceId} />
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
          <p>Only someone who edits audit findings and can see the record may remove the link.</p>
          <ReferenceId id={error.referenceId} />
        </AlertDescription>
      </Alert>
    );
  }
  return <ApiProblem error={error} title={title} />;
}

/** The API's refusal of a new link, in plain words. */
function AddRefusal({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Alert variant="destructive" role="alert">
        <SearchX aria-hidden />
        <AlertTitle>The link wasn&apos;t added</AlertTitle>
        <AlertDescription>
          <p>{NOT_FOUND_TEXT}</p>
        </AlertDescription>
      </Alert>
    );
  }
  let title = 'The link wasn’t added';
  if (error instanceof ApiError) {
    if (error.code === 'link_exists') title = 'The finding already concerns this record';
    else if (error.status === 403) title = 'You can’t link this record';
  }
  return <ApiProblem error={error} title={title} />;
}

/** "Link a control or risk": choose the kind, find the record by name or number, add. */
function LinkConcernDialog({
  finding,
  viewer,
  linkedIds,
  onLinked,
}: {
  finding: Finding;
  viewer: Viewer;
  /** The records the finding already concerns, left out of the results. */
  linkedIds: ReadonlySet<string>;
  onLinked: (message: string) => void;
}) {
  const kindId = useId();
  const searchId = useId();
  const kinds = CONCERN_KINDS.filter((k) => mayLinkTo(viewer, finding, { kind: k, label: 'public' }));
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ConcernKind>(kinds[0] ?? 'control');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; number: string; name: string } | null>(null);
  const add = useAddConcern(finding.id);
  const found = useLinkSearch(kind, q);

  useEffect(() => {
    const next = text.trim();
    const timer = setTimeout(() => setQ(next), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const candidates = (found.data?.items ?? []).filter(
    (other) => !linkedIds.has(other.id) && mayLinkTo(viewer, finding, { kind, label: other.label, owner: other.owner }),
  );

  const reset = (nextKind: ConcernKind) => {
    setKind(nextKind);
    setText('');
    setQ('');
    setPicked(null);
    add.reset();
  };

  const submit = () => {
    if (!picked) return;
    add.mutate(picked.id, {
      onSuccess: () => {
        setOpen(false);
        onLinked(`${finding.number} now concerns ${picked.number} ${picked.name}.`);
      },
    });
  };

  const plural = PLURAL[kind];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (add.isPending) return;
        if (next) reset(kinds[0] ?? 'control');
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus aria-hidden />
          Link a control or risk
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="text-primary size-4" aria-hidden />
            Link {finding.number} to a control or risk
          </DialogTitle>
          <DialogDescription>
            Choose whether the finding concerns a control or a risk, then find it by name or number.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-2">
            <FieldLabel htmlFor={kindId}>It concerns a</FieldLabel>
            <NativeSelect id={kindId} value={kind} onChange={(event) => reset(event.target.value as ConcernKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_TITLE[k]}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-2">
            <FieldLabel htmlFor={searchId}>Search</FieldLabel>
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                id={searchId}
                type="search"
                className="pl-8"
                autoComplete="off"
                placeholder={`Find ${plural} by name or number`}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          </div>

          <div className="bg-muted/30 min-h-32 rounded-md border">
            {q === '' ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                Type a name or number to find {plural}.
              </p>
            ) : found.isPending ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm" role="status">
                Searching {plural}…
              </p>
            ) : found.isError ? (
              <div className="p-3">
                <ApiProblem error={found.error} title={`The ${plural} couldn’t be searched`} />
              </div>
            ) : candidates.length === 0 ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                No {plural} you can link match &ldquo;{q}&rdquo;.
              </p>
            ) : (
              <ul aria-label={`Matching ${plural}`} className="max-h-64 divide-y overflow-y-auto">
                {candidates.map((other) => {
                  const selected = picked?.id === other.id;
                  return (
                    <li key={other.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setPicked({ id: other.id, number: other.number, name: other.name });
                          add.reset();
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none',
                          'hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:ring-inset',
                          selected && 'bg-primary/10 hover:bg-primary/10',
                        )}
                      >
                        <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                          {selected ? <Check className="text-primary size-4" /> : null}
                        </span>
                        <span className="w-24 shrink-0 font-semibold tabular-nums">{other.number}</span>{' '}
                        <span className="min-w-0 flex-1 truncate">{other.name}</span>{' '}
                        <LabelBadge label={other.label as Label} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {add.error ? <AddRefusal error={add.error} /> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!picked || add.isPending}>
              <Link2 aria-hidden />
              {add.isPending ? 'Linking…' : 'Link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The confirmation before a concern is removed: names the link and says it's audited. */
function RemoveConcernDialog({
  finding,
  target,
  pending,
  onConfirm,
  onCancel,
}: {
  finding: Finding;
  target: Concern | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
              {target ? (
                <div className="bg-muted/40 text-foreground rounded-md border px-3 py-2.5">
                  <p className="text-muted-foreground text-xs font-medium">
                    {finding.number} concerns this {KIND_NOUN[target.kind]}
                  </p>
                  <p className="mt-0.5 text-sm">
                    <span className="font-semibold tabular-nums">{target.number}</span> {target.name}
                  </p>
                </div>
              ) : null}
              <p>
                The finding and the {target ? KIND_NOUN[target.kind] : 'record'} stay as they are; only the link between
                them goes. A finding must concern at least one control or risk. The removal is recorded in the audit
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

export function ConcernsList({ finding, viewer }: { finding: Finding; viewer: Viewer | null }) {
  const title = 'Controls and risks it concerns';
  const query = useFindingConcerns(finding.id);
  const remove = useRemoveConcern(finding.id);
  const [target, setTarget] = useState<Concern | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ error: unknown; subject: string } | null>(null);

  const items = [...(query.data ?? [])].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.number.localeCompare(b.number),
  );
  const linkedIds = new Set(items.map((row) => row.id));
  const mayLink = mayLinkAny(viewer, finding);
  const canRemove = (row: Concern) => mayRemoveConcern(viewer, finding, row);
  const actions = items.some(canRemove);

  const startRemoval = (row: Concern) => {
    remove.reset();
    setNotice(null);
    setRefused(null);
    setTarget(row);
  };

  const confirmRemoval = () => {
    if (!target) return;
    const row = target;
    remove.mutate(row.id, {
      onSuccess: () => {
        setTarget(null);
        setNotice(`${finding.number} no longer concerns ${row.number} ${row.name}.`);
      },
      onError: (error) => {
        setTarget(null);
        setRefused({ error, subject: row.number });
      },
    });
  };

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
        <p role="status" className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          {notice ? (
            <>
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              <span className="truncate">{notice}</span>
            </>
          ) : null}
        </p>
        {mayLink && viewer ? (
          <div className="ml-auto">
            <LinkConcernDialog
              finding={finding}
              viewer={viewer}
              linkedIds={linkedIds}
              onLinked={(message) => {
                setRefused(null);
                setNotice(message);
              }}
            />
          </div>
        ) : null}
      </div>
      {refused ? (
        <div className="border-b p-4">
          <RemovalRefusal error={refused.error} subject={refused.subject} />
        </div>
      ) : null}
      {query.isPending ? (
        <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading the controls and risks…</span>
        </div>
      ) : query.isError ? (
        <div className="p-4">
          <ApiProblem error={query.error} title="The controls and risks couldn’t be loaded" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground px-5 py-5 text-sm">No controls or risks to show.</p>
      ) : (
        <Table aria-label={title}>
          <TableHeader>
            <TableRow className="text-muted-foreground">
              <TableHead className="w-24 pl-5">Type</TableHead>
              <TableHead className="w-32">Number</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-28">Label</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className={actions ? 'w-20' : 'w-20 pr-5'}>Origin</TableHead>
              {actions ? (
                <TableHead className="w-28 pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={`${row.kind}:${row.id}`} className="hover:bg-muted/40">
                <TableCell className="text-muted-foreground pl-5">{KIND_TITLE[row.kind]}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <ConcernNumberLink kind={row.kind} id={row.id} number={row.number} />
                </TableCell>
                <TableCell className="max-w-0 truncate" title={row.name}>
                  {row.name}
                </TableCell>
                <TableCell>
                  <LabelBadge label={row.label} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className={actions ? undefined : 'pr-5'}>
                  <ConcernOrigin origin={row.origin} />
                </TableCell>
                {actions ? (
                  <TableCell className="py-1 pr-3 text-right">
                    {canRemove(row) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive h-7"
                        aria-label={`Remove link to ${row.number}`}
                        onClick={() => startRemoval(row)}
                      >
                        <Unlink aria-hidden />
                        Remove
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <RemoveConcernDialog
        finding={finding}
        target={target}
        pending={remove.isPending}
        onConfirm={confirmRemoval}
        onCancel={() => setTarget(null)}
      />
    </section>
  );
}
