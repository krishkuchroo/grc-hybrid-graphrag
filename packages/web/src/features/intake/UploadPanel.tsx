// The upload panel of Data intake (S3-011, D27 #10, D53): what the file is (only the kinds
// `canUpload` allows the person), the source system for an asset list, the label (Internal to
// start with, nothing above the person's clearance, D51, D198), and the file, dropped or picked.
// The file's name and size are checked here before anything is sent; the API checks its contents
// again and decides (D7). The upload's progress shows as it goes, and its answer as a notice: a new
// file, or a repeat of one the org already has, which stores nothing new.
import { Link } from '@tanstack/react-router';
import { MAX_UPLOAD_BYTES, sourceNameSchema, type Label, type UploadKind } from '@grc/shared';
import {
  CircleCheck,
  FileSpreadsheet,
  FileText,
  FileUp,
  Info,
  ScrollText,
  ShieldAlert,
  Siren,
  TriangleAlert,
  UploadCloud,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ApiError, type PostUploadsResponse, type UploadProgress } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label as FieldLabel } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatDay, words } from '@/features/records/format';
import { cn } from '@/lib/utils';
import { AppLink, importHref } from './DocumentsTable';
import {
  acceptFor,
  checkUploadFile,
  extensionOf,
  formatBytes,
  KIND_HINT,
  KIND_TEXT,
  kindFormatsText,
  startingUploadLabel,
  uploadLabelChoices,
} from './permissions';
import { useDocumentImport, useUpload } from './useDocuments';

const KIND_ICON: Record<UploadKind, LucideIcon> = {
  asset_list: FileSpreadsheet,
  policy_document: ScrollText,
  soc_ticket: Siren,
  audit_report: ShieldAlert,
};

const SOURCE_RULE = 'Use 1 to 100 letters, digits, spaces, _, - or .';

/** The words for a refused upload: 415, 413, 429 and 403 in plain terms; anything else as the API
 * put it, with its reference ID. */
function UploadRefused({ error, onDismiss }: { error: unknown; onDismiss: () => void }) {
  const dismiss = (
    <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onDismiss}>
      Dismiss
    </Button>
  );
  if (error instanceof ApiError && error.code === 'aborted') {
    return (
      <Alert variant="info" role="status">
        <Info aria-hidden />
        <AlertTitle>Upload cancelled</AlertTitle>
        <AlertDescription>
          <p>Nothing was stored.</p>
        </AlertDescription>
      </Alert>
    );
  }
  let plain: { title: string; lines: string[] } | null = null;
  if (error instanceof ApiError) {
    switch (error.status) {
      case 415:
        plain = {
          title: 'This file type isn’t accepted',
          lines: [
            error.code === 'unsupported_file_type' ? error.message : '',
            'Upload a PDF, DOCX, CSV, JSON or TXT file whose name ends in its type.',
          ],
        };
        break;
      case 413:
        plain = { title: 'This file is too big', lines: ['Files are limited to 25 MB.'] };
        break;
      case 429:
        plain = {
          title: 'Too many uploads',
          lines: [
            'You can upload 20 files a minute.',
            error.retryAfterSeconds
              ? `Try again in ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? '' : 's'}.`
              : 'Wait a minute, then try again.',
          ],
        };
        break;
      case 403:
        plain = {
          title: 'You can’t upload this',
          lines: [error.message, 'Your role or clearance doesn’t allow this upload.'],
        };
        break;
      default:
        break;
    }
  }
  if (plain === null) {
    return (
      <ApiProblem error={error} title="The file couldn’t be uploaded">
        {dismiss}
      </ApiProblem>
    );
  }
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert aria-hidden />
      <AlertTitle>{plain.title}</AlertTitle>
      <AlertDescription>
        {plain.lines
          .filter((line, i, all) => line !== '' && all.indexOf(line) === i)
          .map((line) => (
            <p key={line}>{line}</p>
          ))}
        {dismiss}
      </AlertDescription>
    </Alert>
  );
}

/** The answer to an upload that went through: a new document, or a repeat. */
function UploadedNotice({ answer, onDismiss }: { answer: PostUploadsResponse; onDismiss: () => void }) {
  const { document } = answer;
  const isAssetList = document.kind === 'asset_list';
  // A repeat answers without the import: the document has it.
  const found = useDocumentImport(answer.duplicate && isAssetList ? document.id : undefined);
  const importId = answer.duplicate ? (found.data ?? undefined) : answer.importId;

  const close = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute top-1.5 right-1.5 size-7"
      aria-label="Dismiss"
      onClick={onDismiss}
    >
      <X aria-hidden />
    </Button>
  );

  if (answer.duplicate) {
    return (
      <Alert variant="info" role="status" className="pr-10">
        <Info aria-hidden />
        <AlertTitle>Already uploaded</AlertTitle>
        <AlertDescription>
          <p>This file was already uploaded on {formatDay(document.createdAt)}; nothing new was stored.</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            {document.kind !== 'evidence' ? (
              <Link
                to="/intake"
                search={{ q: document.fileName }}
                className="font-semibold underline underline-offset-2"
              >
                Show {document.fileName} in the list
              </Link>
            ) : null}
            {importId ? (
              <AppLink href={importHref(importId)} className="font-semibold underline underline-offset-2">
                Open its import
              </AppLink>
            ) : null}
          </p>
        </AlertDescription>
        {close}
      </Alert>
    );
  }

  return (
    <Alert role="status" className="border-[#b9d3c4] bg-[#eef6f1] pr-10 text-[#1d4a33]">
      <CircleCheck aria-hidden />
      <AlertTitle>Uploaded {document.fileName}</AlertTitle>
      <AlertDescription>
        {isAssetList ? (
          <>
            <p>Its columns are being read. Next, match them to asset fields on its import page.</p>
            {importId ? (
              <AppLink href={importHref(importId)} className="font-semibold underline underline-offset-2">
                Open the import
              </AppLink>
            ) : null}
          </>
        ) : (
          <p>It’s stored and queued for processing. Its status shows in the list below.</p>
        )}
      </AlertDescription>
      {close}
    </Alert>
  );
}

export interface UploadPanelProps {
  /** The kinds the person may upload; the panel shows only when there is at least one. */
  kinds: readonly UploadKind[];
  clearance: string;
  /** After an upload goes through, with the API's answer. */
  onUploaded?: (answer: PostUploadsResponse) => void;
}

export function UploadPanel({ kinds, clearance, onUploaded }: UploadPanelProps) {
  const ids = useId();
  const labelChoices = uploadLabelChoices(clearance);
  const [kind, setKind] = useState<UploadKind | undefined>(kinds[0]);
  const [source, setSource] = useState('');
  const [label, setLabel] = useState<Label | undefined>(() => startingUploadLabel(clearance));
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tried, setTried] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [answer, setAnswer] = useState<PostUploadsResponse | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);
  const [manyFiles, setManyFiles] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const upload = useUpload();

  const chosenKind: UploadKind | undefined = kind !== undefined && kinds.includes(kind) ? kind : kinds[0];
  if (chosenKind === undefined) return null;

  const fileProblem = file ? checkUploadFile(chosenKind, file) : null;
  const sourceNeeded = chosenKind === 'asset_list';
  const sourceProblem =
    sourceNeeded && !sourceNameSchema.safeParse(source.trim()).success
      ? source.trim() === ''
        ? `Enter the system this list came from. ${SOURCE_RULE}`
        : SOURCE_RULE
      : null;
  const uploading = upload.isPending;

  const pickFile = (next: File | null) => {
    setFile(next);
    setRefusal(null);
    if (inputRef.current && next === null) inputRef.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const dropped = event.dataTransfer.files;
    if (dropped.length === 0) return;
    if (dropped.length > 1) {
      setRefusal(null);
      setFile(null);
      setTried(true);
      setManyFiles(true);
      return;
    }
    setManyFiles(false);
    pickFile(dropped[0] ?? null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (uploading || !file || fileProblem || sourceProblem) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setAnswer(null);
    setRefusal(null);
    setProgress({ loaded: 0, total: file.size });
    upload.mutate(
      {
        body: {
          file,
          kind: chosenKind,
          ...(label !== undefined ? { label } : {}),
          ...(sourceNeeded ? { source: source.trim() } : {}),
        },
        onProgress: setProgress,
        signal: controller.signal,
      },
      {
        onSuccess: (result) => {
          setAnswer(result);
          setTried(false);
          pickFile(null);
          onUploaded?.(result);
        },
        onError: (err) => setRefusal(err),
        onSettled: () => {
          abortRef.current = null;
          setProgress(null);
        },
      },
    );
  };

  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  const ext = file ? extensionOf(file.name) : '';

  return (
    <section aria-labelledby={`${ids}-heading`} className="bg-card rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-5 py-3">
        <h2 id={`${ids}-heading`} className="text-sm font-semibold">
          Upload a file
        </h2>
        <p className="text-muted-foreground text-xs">
          PDF, DOCX, CSV, JSON or TXT, up to {formatBytes(MAX_UPLOAD_BYTES)}. A file is stored once, however often it’s
          uploaded.
        </p>
      </div>

      <form noValidate onSubmit={submit} className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="grid min-w-0 content-start gap-4">
          <fieldset disabled={uploading} className="min-w-0">
            <legend className="mb-2 text-sm font-semibold">What are you uploading?</legend>
            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
              {kinds.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <label
                    key={k}
                    className={cn(
                      'bg-card relative flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                      'hover:border-ring/60 has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
                      'has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:shadow-[inset_0_0_0_1px_var(--color-primary)]',
                      'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${ids}-kind`}
                      value={k}
                      checked={chosenKind === k}
                      onChange={() => setKind(k)}
                      className="sr-only"
                    />
                    <Icon className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-sm font-semibold">{KIND_TEXT[k]}</span>
                      <span className="text-muted-foreground text-xs">{kindFormatsText(k)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-muted-foreground mt-2 text-xs">{KIND_HINT[chosenKind]}</p>
          </fieldset>

          <div
            data-dragging={dragging ? 'true' : undefined}
            onDragEnter={(e) => {
              e.preventDefault();
              if (!uploading) setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = uploading ? 'none' : 'copy';
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
            className={cn(
              'relative grid min-h-36 place-items-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
              dragging ? 'border-primary bg-accent' : 'border-input bg-muted/40',
              file && !dragging && 'border-solid',
              file && fileProblem && 'border-destructive/60 bg-[#fdf1f0]',
            )}
          >
            <input
              ref={inputRef}
              id={`${ids}-file`}
              type="file"
              aria-label="File to upload"
              accept={acceptFor(chosenKind)}
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                setManyFiles(false);
                pickFile(e.target.files?.[0] ?? null);
              }}
            />
            {file ? (
              <div className="flex w-full max-w-lg items-center gap-3 text-left">
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
                {!uploading ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      pickFile(null);
                      setTried(false);
                    }}
                  >
                    <X aria-hidden />
                    Remove
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="grid justify-items-center gap-2">
                <UploadCloud
                  className={cn('size-8', dragging ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden
                />
                <p className="text-sm">
                  <span className="font-semibold">Drop a file here</span> or
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  <FileUp aria-hidden />
                  Choose a file
                </Button>
                <p className="text-muted-foreground text-xs">
                  {kindFormatsText(chosenKind)}, up to {formatBytes(MAX_UPLOAD_BYTES)}
                </p>
              </div>
            )}
          </div>
          {file && fileProblem ? (
            <p role="alert" className="text-destructive -mt-2 text-sm font-semibold">
              {fileProblem}
            </p>
          ) : null}
          {manyFiles ? (
            <p role="alert" className="text-destructive -mt-2 text-sm font-semibold">
              Drop one file at a time.
            </p>
          ) : !file && tried ? (
            <p role="alert" className="text-destructive -mt-2 text-sm font-semibold">
              Choose a file to upload.
            </p>
          ) : null}
        </div>

        <div className="grid content-start gap-4 lg:border-l lg:pl-5">
          {sourceNeeded ? (
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={`${ids}-source`}>Source system</FieldLabel>
              <Input
                id={`${ids}-source`}
                value={source}
                maxLength={100}
                disabled={uploading}
                placeholder="ServiceNow CMDB"
                aria-invalid={tried && sourceProblem ? true : undefined}
                aria-describedby={`${ids}-source-hint`}
                onChange={(e) => setSource(e.target.value)}
              />
              {tried && sourceProblem ? (
                <p id={`${ids}-source-hint`} role="alert" className="text-destructive text-xs font-semibold">
                  {sourceProblem}
                </p>
              ) : (
                <p id={`${ids}-source-hint`} className="text-muted-foreground text-xs">
                  Where the list came from. Lists from the same source update the same assets and reuse its column
                  mapping.
                </p>
              )}
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <FieldLabel htmlFor={`${ids}-label`}>Label</FieldLabel>
            <NativeSelect
              id={`${ids}-label`}
              value={label ?? ''}
              disabled={uploading || labelChoices.length === 0}
              aria-describedby={`${ids}-label-hint`}
              onChange={(e) => setLabel(e.target.value as Label)}
            >
              {labelChoices.map((choice) => (
                <option key={choice} value={choice}>
                  {words(choice)}
                </option>
              ))}
            </NativeSelect>
            <p id={`${ids}-label-hint`} className="text-muted-foreground text-xs">
              Who may see the file. Up to your clearance, {words(clearance)}.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" disabled={uploading}>
              <UploadCloud aria-hidden />
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
            {uploading ? (
              <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </form>

      {uploading && progress ? (
        <div className="border-t px-5 py-3" role="status">
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">
              {percent < 100 ? 'Uploading' : 'Checking and storing'} <span className="font-semibold">{file?.name}</span>
            </span>
            <span className="text-muted-foreground tabular-nums">{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="bg-muted h-1.5 overflow-hidden rounded-full"
          >
            <div className="bg-primary h-full rounded-full transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}

      {refusal && !uploading ? (
        <div className="border-t px-5 py-4">
          <UploadRefused error={refusal} onDismiss={() => setRefusal(null)} />
        </div>
      ) : null}

      {answer && !uploading ? (
        <div className="border-t px-5 py-4">
          <UploadedNotice answer={answer} onDismiss={() => setAnswer(null)} />
        </div>
      ) : null}
    </section>
  );
}
