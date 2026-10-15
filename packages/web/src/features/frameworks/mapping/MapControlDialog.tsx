// "Map a control" on a requirement page (S2-007, D212 (3)): find a control by name or number through
// GET /api/v1/controls?q=…, pick it, and confirm. The picker offers only controls the person may map
// (`canMapControl`); a control that already satisfies the requirement shows as mapped and can't be
// picked again. Confirm sends POST /api/v1/mappings; the API decides (D7), so its refusals show here
// in plain words with their reference ID (D47). The form is mounted only while the dialog is open,
// so each opening starts clean.
import type { Label } from '@grc/shared';
import { ListChecks, Plus, Search } from 'lucide-react';
import { useId, useState } from 'react';
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
import { LabelBadge } from '@/features/records/LabelBadge';
import type { Viewer } from '@/features/records/permissions';
import { PickerResults } from './PickerResults';
import { MappingRefusal } from './RemoveMappingDialog';
import { mayMapControl, useAddMapping, useControlSearch, usePausedText } from './useMappings';

interface RequirementEnd {
  id: string;
  code: string;
  title: string;
}

function MapControlForm({
  requirement,
  mappedIds,
  viewer,
  add,
  onCancel,
  onMapped,
}: {
  requirement: RequirementEnd;
  mappedIds: ReadonlySet<string>;
  viewer: Viewer;
  add: ReturnType<typeof useAddMapping>;
  onCancel: () => void;
  onMapped: (message: string) => void;
}) {
  const searchId = useId();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<{ id: string; number: string; name: string } | null>(null);
  const q = usePausedText(text);
  const found = useControlSearch(q);

  const candidates = (found.data?.items ?? []).filter((control) => mayMapControl(viewer, control));
  const pickedIsMapped = picked !== null && mappedIds.has(picked.id);

  const submit = () => {
    if (!picked || pickedIsMapped || add.isPending) return;
    const control = picked;
    add.mutate(
      { controlId: control.id, requirementId: requirement.id },
      { onSuccess: () => onMapped(`${control.number} ${control.name} now satisfies ${requirement.code}.`) },
    );
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-2">
        <FieldLabel htmlFor={searchId}>Search controls</FieldLabel>
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
            placeholder="Find controls by name or number"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </div>

      <PickerResults
        prompt={q === '' ? 'Type a name or number to find controls.' : null}
        searching={found.isPending}
        error={found.isError ? found.error : null}
        errorTitle="The controls couldn’t be searched"
        emptyText={`No controls you can map match “${q}”.`}
        listLabel="Matching controls"
        items={candidates.map((control) => ({
          id: control.id,
          lead: control.number,
          text: control.code ? `${control.name} (${control.code})` : control.name,
          trailing: <LabelBadge label={control.label as Label} />,
          mapped: mappedIds.has(control.id),
        }))}
        pickedId={picked?.id ?? null}
        onPick={(id) => {
          const control = candidates.find((c) => c.id === id);
          if (!control || mappedIds.has(id)) return;
          setPicked({ id: control.id, number: control.number, name: control.name });
          add.reset();
        }}
      />

      {picked && !pickedIsMapped ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          <span className="text-foreground font-semibold tabular-nums">{picked.number}</span> will be recorded as
          satisfying <span className="text-foreground font-semibold">{requirement.code}</span>. The change is recorded
          in the audit trail with your name.
        </p>
      ) : null}

      {add.error ? <MappingRefusal error={add.error} action="add" /> : null}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={add.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!picked || pickedIsMapped || add.isPending}>
          <ListChecks aria-hidden />
          {add.isPending ? 'Mapping…' : 'Map control'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function MapControlDialog({
  requirement,
  mappedIds,
  viewer,
  onMapped,
}: {
  requirement: RequirementEnd;
  /** The controls that already satisfy the requirement. */
  mappedIds: ReadonlySet<string>;
  viewer: Viewer;
  /** Called with a short message once the mapping is saved. */
  onMapped: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const add = useAddMapping();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && add.isPending) return;
        if (next) add.reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus aria-hidden />
          Map a control
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="text-primary size-4" aria-hidden />
            Map a control to {requirement.code}
          </DialogTitle>
          <DialogDescription>
            Find the control that satisfies {requirement.code} {requirement.title} by its name or number.
          </DialogDescription>
        </DialogHeader>
        <MapControlForm
          requirement={requirement}
          mappedIds={mappedIds}
          viewer={viewer}
          add={add}
          onCancel={() => setOpen(false)}
          onMapped={(message) => {
            setOpen(false);
            onMapped(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
