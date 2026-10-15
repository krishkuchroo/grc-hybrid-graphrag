// "Add evidence" on a control page (S3-013, D213 (2)-(4)): the file (dropped or picked, its name and
// size checked here before anything is sent, D53), the name, the date it was collected, an optional
// valid-until date and the label (Confidential to start with, nothing above the person's clearance,
// D51, D198). There is no review field: new evidence is always Pending review. The upload shows its
// progress and can be cancelled. The API checks the file's contents and every rule again and
// decides (D7); its refusals show in plain words above the fields (`EvidenceRefusal`).
import { FileText, FileUp, Info, Paperclip, TriangleAlert, UploadCloud, X } from 'lucide-react';
import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { MAX_UPLOAD_BYTES } from '@grc/shared';
import type { UploadProgress } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label as FieldLabel } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ApiProblem } from '@/features/records/ApiProblem';
import { words } from '@/features/records/format';
import type { Viewer } from '@/features/records/permissions';
import type { AnyRecord } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { extensionOf, formatBytes } from '../permissions';
import {
  checkEvidenceFile,
  EVIDENCE_ACCEPT,
  EVIDENCE_FORMATS_TEXT,
  evidenceFieldProblems,
  evidenceLabelChoices,
  evidenceProblem,
  isAborted,
  localToday,
  nameFromFile,
  startingEvidenceLabel,
  useAddEvidence,
  type Evidence,
  type EvidenceAction,
  type EvidenceFieldErrors,
  type EvidenceFieldValues,
} from './useEvidence';

/** A refused request about evidence, in plain words (409 `evidence_exists`, 415, 413, 429, 403, 404,
 * a stale save); anything else in the API's own words with its reference ID. */
export function EvidenceRefusal({
  error,
  action,
  children,
}: {
  error: unknown;
  action: EvidenceAction;
  children?: ReactNode;
}) {
  const problem = evidenceProblem(error, action);
  if (problem.lines === null) {
    return (
      <ApiProblem error={error} title={problem.title}>
        {children}
      </ApiProblem>
    );
  }
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert aria-hidden />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>
        {problem.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {children}
      </AlertDescription>
    </Alert>
  );
}

function Required() {
  return (
    <span className="text-destructive" aria-hidden>
      *
    </span>
  );
}

/** The evidence's own fields, shared by the add and edit dialogs: name, collected, valid until and
 * label, each with its problem under it. */
export function EvidenceFields({
  values,
  errors,
  labelChoices,
  disabled,
  clearance,
  onChange,
}: {
  values: EvidenceFieldValues;
  errors: EvidenceFieldErrors;
  labelChoices: readonly string[];
  disabled: boolean;
  clearance: string;
  onChange: (next: Partial<EvidenceFieldValues>) => void;
}) {
  const ids = useId();
  const described = (field: keyof EvidenceFieldValues, hint: boolean) =>
    errors[field] ? `${ids}-${field}-error` : hint ? `${ids}-${field}-hint` : undefined;
  const problem = (field: keyof EvidenceFieldValues) =>
    errors[field] ? (
      <p id={`${ids}-${field}-error`} role="alert" className="text-destructive text-xs font-semibold">
        {errors[field]}
      </p>
    ) : null;

  return (
    <fieldset className="grid gap-x-5 gap-y-4 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Evidence details</legend>
      <div className="grid gap-1.5 sm:col-span-2">
        <FieldLabel htmlFor={`${ids}-name`}>
          Name
          <Required />
        </FieldLabel>
        <Input
          id={`${ids}-name`}
          autoComplete="off"
          placeholder="e.g. Q3 access review sign-off"
          value={values.name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={described('name', false)}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {problem('name')}
      </div>

      <div className="grid content-start gap-1.5">
        <FieldLabel htmlFor={`${ids}-collected`}>
          Collected
          <Required />
        </FieldLabel>
        <Input
          id={`${ids}-collected`}
          type="date"
          className="w-auto"
          value={values.collectedDate}
          aria-invalid={errors.collectedDate ? true : undefined}
          aria-describedby={described('collectedDate', true)}
          onChange={(e) => onChange({ collectedDate: e.target.value })}
        />
        {problem('collectedDate') ?? (
          <p id={`${ids}-collectedDate-hint`} className="text-muted-foreground text-xs">
            The day this proof was gathered.
          </p>
        )}
      </div>

      <div className="grid content-start gap-1.5">
        <FieldLabel htmlFor={`${ids}-valid-until`}>
          Valid until <span className="text-muted-foreground font-normal">(optional)</span>
        </FieldLabel>
        <Input
          id={`${ids}-valid-until`}
          type="date"
          className="w-auto"
          value={values.validUntil}
          aria-invalid={errors.validUntil ? true : undefined}
          aria-describedby={described('validUntil', true)}
          onChange={(e) => onChange({ validUntil: e.target.value })}
        />
        {problem('validUntil') ?? (
          <p id={`${ids}-validUntil-hint`} className="text-muted-foreground text-xs">
            Leave empty if it doesn’t expire. It shows as Expiring soon 30 days before.
          </p>
        )}
      </div>

      <div className="grid content-start gap-1.5 sm:col-span-2">
        <FieldLabel htmlFor={`${ids}-label`}>Label</FieldLabel>
        <NativeSelect
          id={`${ids}-label`}
          className="sm:max-w-60"
          value={values.label}
          aria-invalid={errors.label ? true : undefined}
          aria-describedby={described('label', true)}
          onChange={(e) => onChange({ label: e.target.value })}
        >
          {labelChoices.map((label) => (
            <option key={label} value={label}>
              {words(label)}
            </option>
          ))}
        </NativeSelect>
        {problem('label') ?? (
          <p id={`${ids}-label-hint`} className="text-muted-foreground text-xs">
            Who may see it: only people cleared for this label or higher. Up to your clearance, {words(clearance)}.
          </p>
        )}
      </div>
    </fieldset>
  );
}

/** The file chooser: a drop zone with a picker, showing the chosen file and its problem. */
function FilePicker({
  file,
  problem,
  disabled,
  onPick,
}: {
  file: File | null;
  problem: string | null;
  disabled: boolean;
  onPick: (file: File | null, many?: boolean) => void;
}) {
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const ext = file ? extensionOf(file.name) : '';

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = event.dataTransfer.files;
    if (dropped.length === 0) return;
    onPick(dropped.length > 1 ? null : (dropped[0] ?? null), dropped.length > 1);
  };

  return (
    <div
      data-dragging={dragging ? 'true' : undefined}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        'relative grid min-h-28 place-items-center rounded-lg border-2 border-dashed px-4 py-4 text-center transition-colors',
        dragging ? 'border-primary bg-accent' : 'border-input bg-muted/40',
        file && !dragging && 'border-solid',
        file && problem && 'border-destructive/60 bg-[#fdf1f0]',
      )}
    >
      <input
        ref={inputRef}
        id={`${ids}-file`}
        type="file"
        aria-label="Evidence file"
        accept={EVIDENCE_ACCEPT}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      {file ? (
        <div className="flex w-full items-center gap-3 text-left">
          <span className="bg-card text-primary grid size-10 shrink-0 place-items-center rounded-md border">
            <FileText className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={file.name}>
              {file.name}
            </p>
            <p className="text-muted-foreground text-xs">
              {ext ? `${ext.toUpperCase()} file, ` : ''}
              {formatBytes(file.size)}
            </p>
          </div>
          {!disabled ? (
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
                Change
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onPick(null)}>
                <X aria-hidden />
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid justify-items-center gap-2">
          <UploadCloud className={cn('size-7', dragging ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
          <p className="text-sm">
            <span className="font-semibold">Drop the file here</span> or
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <FileUp aria-hidden />
            Choose a file
          </Button>
          <p className="text-muted-foreground text-xs">
            {EVIDENCE_FORMATS_TEXT}, up to {formatBytes(MAX_UPLOAD_BYTES)}
          </p>
        </div>
      )}
    </div>
  );
}

function UploadBar({ progress }: { progress: UploadProgress }) {
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  return (
    <div className="grid gap-1.5" role="status">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold">Uploading…</span>
        <span className="text-muted-foreground tabular-nums">{percent}%</span>
      </div>
      <div
        className="bg-muted h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="bg-primary h-full rounded-full transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function AddEvidenceForm({
  control,
  viewer,
  add,
  onDone,
  onCancel,
}: {
  control: AnyRecord;
  viewer: Viewer;
  add: ReturnType<typeof useAddEvidence>;
  onDone: (item: Evidence) => void;
  onCancel: () => void;
}) {
  const labelChoices = evidenceLabelChoices(viewer);
  const [file, setFile] = useState<File | null>(null);
  const [manyFiles, setManyFiles] = useState(false);
  const [values, setValues] = useState<EvidenceFieldValues>(() => ({
    name: '',
    collectedDate: localToday(),
    validUntil: '',
    label: startingEvidenceLabel(viewer),
  }));
  const [tried, setTried] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploading = add.isPending;

  const fileProblem = file ? checkEvidenceFile(file) : null;
  const errors = tried ? evidenceFieldProblems(values, localToday()) : {};

  const pick = (next: File | null, many = false) => {
    add.reset();
    setManyFiles(many);
    setValues((v) => {
      // A name taken from the file follows the file; a name typed by the person stays.
      const fromOld = file ? nameFromFile(file.name) : '';
      if (next && (v.name.trim() === '' || v.name === fromOld)) return { ...v, name: nameFromFile(next.name) };
      if (!next && v.name === fromOld) return { ...v, name: '' };
      return v;
    });
    setFile(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (uploading) return;
    const problems = evidenceFieldProblems(values, localToday());
    if (!file || fileProblem || Object.keys(problems).length > 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ loaded: 0, total: file.size });
    const validUntil = values.validUntil.trim();
    add.mutate(
      {
        body: {
          file,
          controlId: control.id,
          name: values.name.trim(),
          collectedDate: values.collectedDate.trim(),
          ...(validUntil !== '' ? { validUntil } : {}),
          label: values.label as Evidence['label'],
        },
        onProgress: setProgress,
        signal: controller.signal,
      },
      {
        onSuccess: (item) => onDone(item),
        onSettled: () => {
          abortRef.current = null;
          setProgress(null);
        },
      },
    );
  };

  let notice: ReactNode = null;
  if (add.error && isAborted(add.error)) {
    notice = (
      <Alert variant="info" role="status">
        <Info aria-hidden />
        <AlertTitle>Upload cancelled</AlertTitle>
        <AlertDescription>
          <p>Nothing was stored.</p>
        </AlertDescription>
      </Alert>
    );
  } else if (add.error) {
    notice = <EvidenceRefusal error={add.error} action="add" />;
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-5">
      {notice}
      <div className="grid gap-1.5">
        <span className="text-sm leading-none font-semibold">
          File
          <Required />
        </span>
        <FilePicker file={file} problem={fileProblem} disabled={uploading} onPick={pick} />
        {file && fileProblem ? (
          <p role="alert" className="text-destructive text-xs font-semibold">
            {fileProblem}
          </p>
        ) : manyFiles ? (
          <p role="alert" className="text-destructive text-xs font-semibold">
            Drop one file at a time.
          </p>
        ) : !file && tried ? (
          <p role="alert" className="text-destructive text-xs font-semibold">
            Choose the file to attach.
          </p>
        ) : null}
      </div>

      <EvidenceFields
        values={values}
        errors={errors}
        labelChoices={labelChoices}
        disabled={uploading}
        clearance={viewer.clearance}
        onChange={(next) => setValues((v) => ({ ...v, ...next }))}
      />

      {progress ? <UploadBar progress={progress} /> : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="submit" disabled={uploading}>
          <Paperclip aria-hidden />
          {uploading ? 'Adding…' : 'Add evidence'}
        </Button>
        {uploading ? (
          <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
            Cancel upload
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function AddEvidenceDialog({
  control,
  viewer,
  onAdded,
}: {
  control: AnyRecord;
  viewer: Viewer;
  /** Called with the new evidence once it's saved. */
  onAdded: (item: Evidence) => void;
}) {
  const [open, setOpen] = useState(false);
  /** A new form each time the dialog opens, so nothing chosen before is kept. */
  const [round, setRound] = useState(0);
  const add = useAddEvidence(control.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Not closed mid-upload: Cancel upload stops it first.
        if (add.isPending) return;
        if (next) {
          add.reset();
          setRound((r) => r + 1);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Paperclip aria-hidden />
          Add evidence
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paperclip className="text-primary size-4" aria-hidden />
            Add evidence
          </DialogTitle>
          <DialogDescription>
            Attach a file that shows control{' '}
            <span className="text-foreground font-semibold tabular-nums">{control.number}</span> {control.name} works.
            It’s listed as Pending review until it’s reviewed. Fields marked * are required.
          </DialogDescription>
        </DialogHeader>
        <AddEvidenceForm
          key={round}
          control={control}
          viewer={viewer}
          add={add}
          onCancel={() => setOpen(false)}
          onDone={(item) => {
            setOpen(false);
            onAdded(item);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
