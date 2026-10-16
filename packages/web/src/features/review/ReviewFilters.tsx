// The review list's document and record filters (S5-005): each is a button that opens a picker
// (find an upload by file name, or a record of one kind by name or number) and, once set, a chip
// naming what the list is narrowed to, with a way to clear it. Both can also arrive in the URL
// (`documentId`, `recordId`), from a finding's page; then the chip finds the name to show itself.
import { RECORD_KINDS, type Label, type RecordKind } from '@grc/shared';
import { FileText, Search, Shapes, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
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
import { PickerResults } from '@/features/frameworks/mapping/PickerResults';
import { usePausedText } from '@/features/frameworks/mapping/useMappings';
import { KIND_TEXT } from '@/features/intake/permissions';
import { LabelBadge } from '@/features/records/LabelBadge';
import { useDocumentName, useDocumentSearch, useRecordName, useRecordSearch } from './useReview';
import { RECORD_KIND_TEXT } from './words';

/** A filter that is on: what it is narrowed to, and a button that clears it. */
function FilterChip({
  icon: Icon,
  what,
  children,
  onClear,
}: {
  icon: typeof FileText;
  what: string;
  children: ReactNode;
  onClear: () => void;
}) {
  return (
    <span className="bg-accent text-accent-foreground inline-flex h-8 max-w-[22rem] min-w-0 items-center gap-1.5 rounded-md border border-[#b9d3d7] pr-1 pl-2.5 text-sm">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{what}:</span>
      <span className="min-w-0 truncate">{children}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear the ${what.toLowerCase()} filter`}
        className="hover:bg-primary/10 focus-visible:ring-ring/50 grid size-6 shrink-0 place-items-center rounded outline-none focus-visible:ring-[3px]"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

function SearchBox({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          id={id}
          type="search"
          className="pl-8"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

// ---- Document ------------------------------------------------------------------------------

function DocumentPicker({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const searchId = useId();
  const [text, setText] = useState('');
  const q = usePausedText(text);
  const found = useDocumentSearch(q);
  const items = found.data?.items ?? [];
  return (
    <div className="grid gap-4">
      <SearchBox
        id={searchId}
        label="Search uploads"
        placeholder="Find an upload by file name"
        value={text}
        onChange={setText}
      />
      <PickerResults
        prompt={q === '' ? 'Type part of a file name to find the upload.' : null}
        searching={found.isPending}
        error={found.isError ? found.error : null}
        errorTitle="The uploads couldn’t be searched"
        emptyText={`No uploads you can see match “${q}”.`}
        listLabel="Matching uploads"
        items={items.map((document) => ({
          id: document.id,
          lead: KIND_TEXT[document.kind],
          text: document.fileName,
          trailing: <LabelBadge label={document.label as Label} />,
          mapped: false,
        }))}
        pickedId={null}
        onPick={onPick}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The document filter: a picker, or the chosen upload's name. */
export function DocumentFilter({
  documentId,
  onChange,
}: {
  documentId: string | undefined;
  onChange: (documentId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = useDocumentName(documentId);
  if (documentId) {
    const text = name.isPending ? 'Finding the upload…' : (name.data ?? 'An upload you can’t see');
    return (
      <FilterChip icon={FileText} what="Document" onClear={() => onChange(undefined)}>
        {text}
      </FilterChip>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9">
          <FileText aria-hidden />
          Document
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Show findings from one upload</DialogTitle>
          <DialogDescription>Only the findings the extraction made from that document are listed.</DialogDescription>
        </DialogHeader>
        {open ? (
          <DocumentPicker
            onCancel={() => setOpen(false)}
            onPick={(id) => {
              setOpen(false);
              onChange(id);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---- Record --------------------------------------------------------------------------------

function RecordPicker({
  onPick,
  onCancel,
}: {
  onPick: (record: { id: string; kind: RecordKind }) => void;
  onCancel: () => void;
}) {
  const searchId = useId();
  const kindId = useId();
  const [kind, setKind] = useState<RecordKind>('asset');
  const [text, setText] = useState('');
  const q = usePausedText(text);
  const found = useRecordSearch(kind, q);
  const noun = RECORD_KIND_TEXT[kind].toLowerCase();
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="grid gap-2">
          <FieldLabel htmlFor={kindId}>Kind</FieldLabel>
          <NativeSelect id={kindId} value={kind} onChange={(event) => setKind(event.target.value as RecordKind)}>
            {RECORD_KINDS.map((k) => (
              <option key={k} value={k}>
                {RECORD_KIND_TEXT[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <SearchBox
          id={searchId}
          label="Search records"
          placeholder={`Find a ${noun} by name or number`}
          value={text}
          onChange={setText}
        />
      </div>
      <PickerResults
        prompt={q === '' ? `Type a name or number to find the ${noun}.` : null}
        searching={found.isPending}
        error={found.isError ? found.error : null}
        errorTitle="The records couldn’t be searched"
        emptyText={`No ${noun} you can see matches “${q}”.`}
        listLabel="Matching records"
        items={(found.data?.items ?? []).map((record) => ({
          id: record.id,
          lead: record.number,
          text: record.name,
          trailing: <LabelBadge label={record.label} />,
          mapped: false,
        }))}
        pickedId={null}
        onPick={(id) => onPick({ id, kind })}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The record filter: a picker, or the chosen record's number and name. `known` is the record as a
 * row on screen names it, when the URL gave no kind to look it up by. */
export function RecordFilter({
  recordId,
  recordKind,
  known,
  onChange,
}: {
  recordId: string | undefined;
  recordKind: RecordKind | undefined;
  known: { number: string; name: string } | undefined;
  onChange: (record: { id: string; kind: RecordKind } | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const looked = useRecordName(known ? undefined : recordKind, recordId);
  if (recordId) {
    let text: ReactNode;
    const record = known ?? looked.data ?? null;
    if (record) {
      text = (
        <>
          <span className="font-semibold tabular-nums">{record.number}</span> {record.name}
        </>
      );
    } else if (recordKind && looked.isPending) {
      text = 'Finding the record…';
    } else {
      text = recordKind ? 'A record you can’t see' : 'One record';
    }
    return (
      <FilterChip icon={Shapes} what="Record" onClear={() => onChange(undefined)}>
        {text}
      </FilterChip>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9">
          <Shapes aria-hidden />
          Record
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Show findings that name one record</DialogTitle>
          <DialogDescription>
            A finding names a record as an end of its link, a possible match, one of a duplicate pair, or what its
            approval made.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <RecordPicker
            onCancel={() => setOpen(false)}
            onPick={(record) => {
              setOpen(false);
              onChange(record);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
