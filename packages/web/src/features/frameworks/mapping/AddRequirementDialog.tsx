// "Add requirement" on a control page (S2-007, D212 (3)): pick a framework, find its requirement by
// code or title through GET /api/v1/frameworks/:id/requirements?q=…, pick it, and confirm. A
// requirement the control already satisfies shows as mapped and can't be picked again. Confirm sends
// POST /api/v1/mappings; the API decides (D7), so its refusals show here in plain words with their
// reference ID (D47). Shown only to people who may map this control (`canMapControl`). The form is
// mounted only while the dialog is open, so nothing is asked for until then and each opening
// starts clean.
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
import { NativeSelect } from '@/components/ui/native-select';
import { ApiProblem } from '@/features/records/ApiProblem';
import { groupLabel, useFrameworks } from '../useFrameworks';
import { PickerResults } from './PickerResults';
import { MappingRefusal } from './RemoveMappingDialog';
import { useAddMapping, usePausedText, useRequirementSearch } from './useMappings';

interface ControlEnd {
  id: string;
  number: string;
  name: string;
}

function AddRequirementForm({
  control,
  mappedIds,
  add,
  onCancel,
  onMapped,
}: {
  control: ControlEnd;
  mappedIds: ReadonlySet<string>;
  add: ReturnType<typeof useAddMapping>;
  onCancel: () => void;
  onMapped: (message: string) => void;
}) {
  const frameworkFieldId = useId();
  const searchId = useId();
  const [frameworkId, setFrameworkId] = useState('');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<{ id: string; code: string; title: string } | null>(null);
  const frameworks = useFrameworks();
  const q = usePausedText(text);
  const found = useRequirementSearch(frameworkId, q);

  const framework = frameworks.data?.items.find((f) => f.id === frameworkId);
  const results = found.data?.items ?? [];
  const pickedIsMapped = picked !== null && mappedIds.has(picked.id);

  const submit = () => {
    if (!picked || pickedIsMapped || add.isPending) return;
    const requirement = picked;
    add.mutate(
      { controlId: control.id, requirementId: requirement.id },
      { onSuccess: () => onMapped(`${control.number} now satisfies ${requirement.code} ${requirement.title}.`) },
    );
  };

  let prompt: string | null = null;
  if (frameworkId === '') prompt = 'Choose a framework, then type a code or title to find its requirements.';
  else if (q === '') prompt = `Type a code or title to find ${framework?.name ?? 'the framework'}’s requirements.`;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-2">
        <FieldLabel htmlFor={frameworkFieldId}>Framework</FieldLabel>
        <NativeSelect
          id={frameworkFieldId}
          value={frameworkId}
          disabled={!frameworks.data}
          onChange={(event) => {
            setFrameworkId(event.target.value);
            setPicked(null);
            add.reset();
          }}
        >
          <option value="">{frameworks.isPending ? 'Loading frameworks…' : 'Choose a framework'}</option>
          {(frameworks.data?.items ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.frameworkVersion}
            </option>
          ))}
        </NativeSelect>
        {frameworks.isError ? <ApiProblem error={frameworks.error} title="The frameworks couldn’t be loaded" /> : null}
      </div>

      <div className="grid gap-2">
        <FieldLabel htmlFor={searchId}>Search requirements</FieldLabel>
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
            disabled={frameworkId === ''}
            placeholder={frameworkId === '' ? 'Choose a framework first' : 'Find requirements by code or title'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </div>

      <PickerResults
        prompt={prompt}
        searching={found.isPending}
        error={found.isError ? found.error : null}
        errorTitle="The requirements couldn’t be searched"
        emptyText={framework ? `No ${framework.name} requirements match “${q}”.` : `No requirements match “${q}”.`}
        listLabel="Matching requirements"
        items={results.map((r) => ({
          id: r.id,
          lead: r.code,
          text: r.title,
          trailing: (
            <span className="text-muted-foreground hidden max-w-40 shrink-0 truncate text-xs sm:inline">
              {groupLabel(r.framework, r.group)}
            </span>
          ),
          mapped: mappedIds.has(r.id),
        }))}
        pickedId={picked?.id ?? null}
        onPick={(id) => {
          const requirement = results.find((r) => r.id === id);
          if (!requirement || mappedIds.has(id)) return;
          setPicked({ id: requirement.id, code: requirement.code, title: requirement.title });
          add.reset();
        }}
      />

      {picked && !pickedIsMapped ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          <span className="text-foreground font-semibold tabular-nums">{control.number}</span> will be recorded as
          satisfying <span className="text-foreground font-semibold">{picked.code}</span>. The change is recorded in the
          audit trail with your name.
        </p>
      ) : null}

      {add.error ? <MappingRefusal error={add.error} action="add" /> : null}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={add.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!picked || pickedIsMapped || add.isPending}>
          <ListChecks aria-hidden />
          {add.isPending ? 'Adding…' : 'Add requirement'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AddRequirementDialog({
  control,
  mappedIds,
  onMapped,
}: {
  control: ControlEnd;
  /** The requirements the control already satisfies. */
  mappedIds: ReadonlySet<string>;
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
          Add requirement
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="text-primary size-4" aria-hidden />
            Add a requirement {control.number} satisfies
          </DialogTitle>
          <DialogDescription>Choose the framework, then find the requirement by its code or title.</DialogDescription>
        </DialogHeader>
        <AddRequirementForm
          control={control}
          mappedIds={mappedIds}
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
