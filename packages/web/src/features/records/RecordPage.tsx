// One record, in the ServiceNow form style (D2): the number as the title, the name under it, the
// label and status beside, every field in a two-column sheet, and the owner and dates at the side.
// Edit and Retire show only when the role table allows (D50); the API decides anyway (D7), so a
// refusal still shows its message. A stale save (409, D69) keeps what was typed and offers Reload.
import { can, type RecordKind } from '@grc/shared';
import { CircleCheck, Pencil, RefreshCw, SearchX, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ApiProblem, NOT_FOUND_TEXT } from './ApiProblem';
import { formatMoment, words } from './format';
import { LabelBadge } from './LabelBadge';
import { canCreateRecord, canEditRecord, createLabelChoices, editLabelChoices, startingLabel } from './permissions';
import { RecordForm, type FormFieldDef, type FormValues } from './RecordForm';
import { RetireDialog } from './RetireDialog';
import {
  isNotFound,
  isStale,
  useCreateRecord,
  useMe,
  usePeople,
  useRecord,
  useRetireRecord,
  useUpdateRecord,
  type AnyRecord,
} from './useRecords';

export interface DetailItem {
  label: string;
  value: ReactNode;
  /** Spans both columns. */
  wide?: boolean;
}

interface Props<R extends AnyRecord> {
  kind: RecordKind;
  id: string;
  /** "risk", "control"… */
  noun: string;
  /** The way back to the list, shown above the title. */
  back: ReactNode;
  /** The kind's own fields, in the order the sheet shows them. */
  details: (record: R) => DetailItem[];
  /** An optional panel at the top of the side column (a risk's rating). */
  summary?: (record: R) => ReactNode;
  /** Optional sections under the details (an asset's dependency map). */
  sections?: (record: R) => ReactNode;
  formFields: readonly FormFieldDef[];
  /** The record's own fields as the form holds them (text). */
  formValues: (record: R) => FormValues;
  /**
   * Called after a save that leaves the person unable to see the record any more (a Control Owner
   * handing their control to someone else, D206), with the new owner's name. The page doesn't ask
   * the API for it again, so the not-found page never shows for it.
   */
  onHandedOver?: (record: R, ownerName: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold',
        status === 'active'
          ? 'border-[#9fcdb1] bg-[#e4f2e9] text-[#1f5c38]'
          : 'border-border bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', status === 'active' ? 'bg-[#2f8a55]' : 'bg-muted-foreground')}
        aria-hidden
      />
      {words(status)}
    </span>
  );
}

function Sheet({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 px-5 py-5 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className={cn('grid gap-1', item.wide && 'sm:col-span-2')}>
          <dt className="text-muted-foreground text-xs font-semibold">{item.label}</dt>{' '}
          <dd className="text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('bg-card rounded-lg border shadow-xs', className)}>
      <h2 className="border-b px-5 py-2.5 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** The one page for a record that is missing or hidden: the same for every cause. */
export function RecordNotFound({ back }: { back: ReactNode }) {
  return (
    <div className="px-8 py-10">
      <div className="bg-card mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border px-6 py-12 text-center">
        <span className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-full">
          <SearchX className="size-5" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">Record not found</h1>
        <p className="text-muted-foreground text-sm">{NOT_FOUND_TEXT}</p>
        <div className="text-sm">{back}</div>
      </div>
    </div>
  );
}

/** The create page: the same form, empty, with the kind's starting label and the person as owner. */
export function NewRecordPage({
  kind,
  noun,
  back,
  formFields,
  onCreated,
  onCancel,
}: {
  kind: RecordKind;
  noun: string;
  back: ReactNode;
  formFields: readonly FormFieldDef[];
  onCreated: (record: AnyRecord) => void;
  onCancel: () => void;
}) {
  const me = useMe();
  const create = useCreateRecord(kind);
  const viewer = me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
  if (!viewer) return null;

  const initial: FormValues = {
    name: '',
    owner: viewer.userId,
    label: startingLabel(viewer, kind),
    ...Object.fromEntries(formFields.map((f) => [f.name, ''])),
  };

  return (
    <>
      <div className="bg-card border-b px-8 pt-4 pb-5">
        <div className="text-muted-foreground mb-2 text-xs">{back}</div>
        <h1 className="text-xl font-semibold tracking-tight">New {noun}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The number is given when you create it. Fields marked * are required.
        </p>
      </div>
      <div className="px-8 py-6">
        <Panel title={`${words(noun)} details`} className="max-w-3xl">
          <div className="px-5 py-5">
            {canCreateRecord(viewer, kind) ? (
              <RecordForm
                kind={kind}
                mode="create"
                fields={formFields}
                initial={initial}
                labelChoices={createLabelChoices(viewer)}
                submitText={`Create ${noun}`}
                pending={create.isPending}
                notice={create.error ? <ApiProblem error={create.error} title={`The ${noun} wasn’t created`} /> : null}
                onCancel={onCancel}
                onSubmit={({ all }) => create.mutate(all, { onSuccess: onCreated })}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Your role can&apos;t create a new {noun}.</p>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

export function RecordPage<R extends AnyRecord>({
  kind,
  id,
  noun,
  back,
  details,
  summary,
  sections,
  formFields,
  formValues,
  onHandedOver,
}: Props<R>) {
  const me = useMe();
  const people = usePeople();
  const query = useRecord(kind, id);
  const viewer = me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
  /** Whether the person can still see a record after saving it: the D50 cell, with ownership. */
  const keepsAccess = (saved: AnyRecord) =>
    viewer === null || can(viewer.role, kind, 'view', { isOwner: saved.owner === viewer.userId });
  const update = useUpdateRecord(kind, id, { keepsAccess });
  const retire = useRetireRecord(kind, id);
  /** The record as it was when the form opened: its version goes with the save (D69). */
  const [opened, setOpened] = useState<AnyRecord | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the {noun}…</span>
      </div>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) return <RecordNotFound back={back} />;
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-sm">{back}</div>
        <ApiProblem error={query.error} title={`This ${noun} couldn't be opened`} />
      </div>
    );
  }

  const record = query.data as R;
  const nameOf = (userId: string) => (people.data ?? []).find((p) => p.id === userId)?.name ?? '—';
  const mayEdit = viewer !== null && canEditRecord(viewer, kind, record);
  const editing = opened !== null;

  const startEdit = () => {
    update.reset();
    setDone(null);
    setOpened(record);
  };

  const reload = async () => {
    const latest = await query.refetch();
    if (latest.data) {
      update.reset();
      setOpened(latest.data);
    }
  };

  let notice: ReactNode = null;
  const saveError = update.error;
  if (saveError && isStale(saveError)) {
    notice = (
      <Alert variant="destructive" role="alert">
        <TriangleAlert aria-hidden />
        <AlertTitle>This record changed since you opened it</AlertTitle>
        <AlertDescription>
          <p>
            Someone else saved it while you were editing, so your changes weren&apos;t saved. Your typed changes are
            still in the form below. Reload to get the latest version, then re-apply your changes and save again.
          </p>
          <Button type="button" size="sm" variant="outline" className="mt-1" onClick={() => void reload()}>
            <RefreshCw aria-hidden />
            Reload latest version
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (saveError && isNotFound(saveError)) {
    notice = (
      <Alert variant="destructive" role="alert">
        <SearchX aria-hidden />
        <AlertTitle>Your changes weren&apos;t saved</AlertTitle>
        <AlertDescription>
          <p>{NOT_FOUND_TEXT}</p>
        </AlertDescription>
      </Alert>
    );
  } else if (saveError) {
    notice = (
      <ApiProblem
        error={saveError}
        title={
          saveError instanceof ApiError && saveError.status === 403
            ? 'You can’t save these changes'
            : 'Your changes weren’t saved'
        }
      />
    );
  }

  return (
    <>
      <div className="bg-card border-b px-8 pt-4 pb-5">
        <div className="text-muted-foreground mb-2 text-xs">{back}</div>
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight tabular-nums">{record.number}</h1>
              <StatusBadge status={record.status} />
              <LabelBadge label={record.label} />
            </div>
            <p className="text-muted-foreground max-w-[70ch] text-sm">{record.name}</p>
          </div>
          {mayEdit && !editing ? (
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" onClick={startEdit}>
                <Pencil aria-hidden />
                Edit
              </Button>
              {record.status === 'active' ? (
                <RetireDialog
                  number={record.number}
                  noun={noun}
                  pending={retire.isPending}
                  error={retire.error}
                  onOpenChange={(open) => {
                    if (open) retire.reset();
                  }}
                  onConfirm={async () => {
                    await retire.mutateAsync(record.version);
                    setDone(`${record.number} was retired. It no longer shows in the active list.`);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-4">
          {done ? (
            <Alert variant="info" role="status">
              <CircleCheck aria-hidden />
              <AlertDescription>
                <p>{done}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {editing ? (
            <Panel title={`Edit ${noun}`}>
              <div className="px-5 py-5">
                <RecordForm
                  key={opened.version}
                  kind={kind}
                  mode="edit"
                  fields={formFields}
                  initial={{
                    name: opened.name,
                    owner: opened.owner,
                    label: opened.label,
                    ...formValues(opened as R),
                  }}
                  labelChoices={viewer ? editLabelChoices(viewer, opened.label) : [opened.label]}
                  submitText="Save changes"
                  pending={update.isPending}
                  notice={notice}
                  onCancel={() => {
                    update.reset();
                    setOpened(null);
                  }}
                  onSubmit={({ changed }) => {
                    if (Object.keys(changed).length === 0) {
                      setOpened(null);
                      return;
                    }
                    update.mutate(
                      { ...changed, version: opened.version },
                      {
                        onSuccess: (saved) => {
                          if (onHandedOver && !keepsAccess(saved)) {
                            onHandedOver(saved as R, nameOf(saved.owner));
                            return;
                          }
                          setOpened(null);
                          setDone('Changes saved.');
                        },
                      },
                    );
                  }}
                />
              </div>
            </Panel>
          ) : (
            <Panel title="Details">
              <Sheet items={[{ label: 'Name', value: record.name, wide: true }, ...details(record)]} />
            </Panel>
          )}
          {sections ? sections(record) : null}
        </div>

        <aside className="grid content-start gap-4">
          {summary ? summary(record) : null}
          <Panel title="Record">
            <Sheet
              items={[
                { label: 'Owner', value: nameOf(record.owner), wide: true },
                { label: 'Label', value: <LabelBadge label={record.label} />, wide: true },
                { label: 'Status', value: words(record.status) },
                { label: 'Origin', value: words(record.origin) },
                {
                  label: 'Created',
                  value: `${formatMoment(record.createdAt)} by ${nameOf(record.createdBy)}`,
                  wide: true,
                },
                {
                  label: 'Updated',
                  value: `${formatMoment(record.updatedAt)} by ${nameOf(record.updatedBy)}`,
                  wide: true,
                },
              ]}
            />
          </Panel>
        </aside>
      </div>
    </>
  );
}
