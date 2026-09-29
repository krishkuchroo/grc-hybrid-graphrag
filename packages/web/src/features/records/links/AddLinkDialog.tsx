// "Add link" (D200): choose how the two records relate, find the other one by name or number through
// its kind's list route, pick it, and add. The web only offers what it knows the API would accept:
// the ontology's ways from this record (LINK_TYPES), and records that pass `canLinkRecords`. The API
// decides (D7), so its refusals show here in plain words with their reference ID (D47).
import { canLinkRecords, type Label, type RecordKind } from '@grc/shared';
import { Check, Link2, Plus, Search, SearchX } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { cn } from '@/lib/utils';
import { ApiProblem, NOT_FOUND_TEXT } from '../ApiProblem';
import { LabelBadge } from '../LabelBadge';
import type { Viewer } from '../permissions';
import type { AnyRecord } from '../useRecords';
import type { LinkWay } from './linkGroups';
import { useAddLink, useLinkSearch } from './useLinks';

/** How long typing must pause before the search is asked. */
const SEARCH_PAUSE_MS = 200;

const PLURAL: Record<RecordKind, string> = {
  risk: 'risks',
  control: 'controls',
  policy: 'policies',
  asset: 'assets',
  incident: 'incidents',
};

const wayKey = (way: LinkWay) => `${way.type}:${way.direction}`;

function Refusal({ error }: { error: unknown }) {
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
    if (error.code === 'link_not_allowed') title = 'These records can’t be linked this way';
    else if (error.code === 'link_exists') title = 'These records are already linked this way';
    else if (error.status === 403) title = 'You can’t link these records';
  }
  return <ApiProblem error={error} title={title} />;
}

export function AddLinkDialog({
  kind,
  record,
  noun,
  viewer,
  ways,
}: {
  kind: RecordKind;
  record: AnyRecord;
  noun: string;
  viewer: Viewer;
  /** The ways offered, already limited to those the person may add (D200). */
  ways: LinkWay[];
}) {
  const typeId = useId();
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(() => wayKey(ways[0]!));
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<AnyRecord | null>(null);
  const add = useAddLink();

  const way = ways.find((w) => wayKey(w) === chosen) ?? ways[0]!;
  const found = useLinkSearch(way.other, q);

  useEffect(() => {
    const next = text.trim();
    const timer = setTimeout(() => setQ(next), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const thisEnd = { kind, label: record.label, owner: record.owner };
  const candidates = (found.data?.items ?? []).filter((other) => {
    if (other.id === record.id) return false;
    const otherEnd = { kind: way.other, label: other.label, owner: other.owner };
    return way.direction === 'out'
      ? canLinkRecords(viewer, thisEnd, otherEnd)
      : canLinkRecords(viewer, otherEnd, thisEnd);
  });

  const reset = () => {
    setChosen(wayKey(ways[0]!));
    setText('');
    setQ('');
    setPicked(null);
    add.reset();
  };

  const submit = () => {
    if (!picked) return;
    const [fromId, toId] = way.direction === 'out' ? [record.id, picked.id] : [picked.id, record.id];
    add.mutate(
      {
        body: { type: way.type, fromId, toId },
        ends: [
          { kind, id: record.id },
          { kind: way.other, id: picked.id },
        ],
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  const otherPlural = PLURAL[way.other];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus aria-hidden />
          Add link
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="text-primary size-4" aria-hidden />
            Link this {noun} to another record
          </DialogTitle>
          <DialogDescription>
            Choose how the records relate, then find the other one by name or number.
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
            <FieldLabel htmlFor={typeId}>Link type</FieldLabel>
            <NativeSelect
              id={typeId}
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
                setText('');
                setQ('');
                setPicked(null);
                add.reset();
              }}
            >
              {ways.map((w) => (
                <option key={wayKey(w)} value={wayKey(w)}>
                  {w.title}
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
                placeholder={`Find ${otherPlural} by name or number`}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          </div>

          <div className="bg-muted/30 min-h-32 rounded-md border">
            {q === '' ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                Type a name or number to find {otherPlural}.
              </p>
            ) : found.isPending ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm" role="status">
                Searching {otherPlural}…
              </p>
            ) : found.isError ? (
              <div className="p-3">
                <ApiProblem error={found.error} title={`The ${otherPlural} couldn’t be searched`} />
              </div>
            ) : candidates.length === 0 ? (
              <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                No {otherPlural} you can link match &ldquo;{q}&rdquo;.
              </p>
            ) : (
              <ul aria-label={`Matching ${otherPlural}`} className="max-h-64 divide-y overflow-y-auto">
                {candidates.map((other) => {
                  const selected = picked?.id === other.id;
                  return (
                    <li key={other.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setPicked(other);
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

          {add.error ? <Refusal error={add.error} /> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!picked || add.isPending}>
              <Link2 aria-hidden />
              Add link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
