// An asset-list import at /intake/imports/$id (S3-012, D44), like a ServiceNow import set (D2): a
// process flow across the top (read the file, map columns, import, results), then what the import
// needs next.
// - Reading: says so and asks again every 2 s.
// - Needs mapping: the field map, pre-filled from the source's saved mapping or suggested from the
//   column names, over the file's sample rows with the chosen columns highlighted. "Run import"
//   shows only for the roles `canImportAssets` allows (D213 (5), R14); it sends the mapping and
//   whether to save it for the source, ticked by default.
// - Queued or importing: progress, asked again every 2 s.
// - Done: the counts, the row problems in plain words and a way to the Assets list (and, for an
//   importer, running it again with another mapping).
// - Failed: the reason in plain words; after a run, an importer can map and run it again.
// A missing or hidden import is the one not-found page (D51); a role kept out of Data intake gets
// its no-access screen. The API decides every permission (D7).
import { canImportAssets, type AssetImportField } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import {
  Check,
  ChevronLeft,
  CircleAlert,
  Info,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  SearchX,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { useMe, usePeople } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { IntakeNoAccess } from '../IntakePage';
import { FORMAT_TEXT } from '../permissions';
import { StatusBadge } from '../StatusBadge';
import { ImportResults } from './ImportResults';
import { fieldSelectId, MappingTable } from './MappingTable';
import { SamplePreview } from './SamplePreview';
import {
  draftFrom,
  draftProblems,
  failureText,
  IMPORT_MOVING,
  IMPORT_NOT_FOUND_TEXT,
  IMPORT_REFRESH_MS,
  importFileName,
  importRolesText,
  runProblem,
  sampleRows,
  useImportDetail,
  useRunImport,
  type ImportDetail,
  type MappingDraft,
  type RunInput,
} from './useImport';

// ---- The process flow ------------------------------------------------------------------------

type StepState = 'complete' | 'current' | 'failed' | 'upcoming';

const STEPS = ['Read the file', 'Map columns', 'Import', 'Results'] as const;

/** Each step's state for an import's status. */
export function stepStates(imp: Pick<ImportDetail, 'status' | 'columns'>): StepState[] {
  const at = (current: number, failed = false): StepState[] =>
    STEPS.map((_, i) => (i < current ? 'complete' : i === current ? (failed ? 'failed' : 'current') : 'upcoming'));
  switch (imp.status) {
    case 'reading':
      return at(0);
    case 'needs_mapping':
      return at(1);
    case 'queued':
    case 'importing':
      return at(2);
    case 'done':
      return STEPS.map(() => 'complete');
    case 'failed':
      return imp.columns === null ? at(0, true) : at(2, true);
  }
}

const NOTCH = '0.625rem';

function chevron(i: number, last: number): CSSProperties {
  const tip = `calc(100% - ${NOTCH})`;
  if (i === 0) return { clipPath: `polygon(0 0, ${tip} 0, 100% 50%, ${tip} 100%, 0 100%)` };
  if (i === last) return { clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${NOTCH} 50%)` };
  return { clipPath: `polygon(0 0, ${tip} 0, 100% 50%, ${tip} 100%, 0 100%, ${NOTCH} 50%)` };
}

const STEP_STYLE: Record<StepState, string> = {
  complete: 'bg-accent text-accent-foreground',
  current: 'bg-primary text-primary-foreground',
  failed: 'bg-destructive text-white',
  upcoming: 'bg-muted text-muted-foreground',
};

const STEP_SR: Record<StepState, string> = {
  complete: 'done',
  current: 'current step',
  failed: 'failed',
  upcoming: 'not started',
};

/** ServiceNow's process flow formatter: the import's steps as chevrons, the current one filled. */
function ProcessFlow({ imp }: { imp: ImportDetail }) {
  const states = stepStates(imp);
  const moving = IMPORT_MOVING.has(imp.status);
  return (
    <ol aria-label="Import steps" className="flex w-full max-w-4xl">
      {STEPS.map((step, i) => {
        const state = states[i] ?? 'upcoming';
        return (
          <li
            key={step}
            aria-current={state === 'current' ? 'step' : undefined}
            data-state={state}
            style={chevron(i, STEPS.length - 1)}
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 px-4 text-xs font-semibold',
              i > 0 && '-ml-1.5 pl-5',
              STEP_STYLE[state],
            )}
          >
            {state === 'complete' ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
            {state === 'failed' ? <X className="size-3.5 shrink-0" aria-hidden /> : null}
            {state === 'current' && moving ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
            ) : null}
            <span className="truncate">{step}</span>
            <span className="sr-only">({STEP_SR[state]})</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---- Shared pieces ---------------------------------------------------------------------------

function BackToIntake() {
  return (
    <Link to="/intake" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Data intake
    </Link>
  );
}

function Panel({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn('bg-card min-w-0 rounded-lg border shadow-xs', className)}>
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Refreshing() {
  return (
    <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs" role="status">
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      Checking for updates every {IMPORT_REFRESH_MS / 1000} s
    </p>
  );
}

function rowsText(imp: ImportDetail): string {
  if (imp.rowCount === null) return imp.status === 'reading' ? 'Counting…' : 'Not known';
  return `${imp.rowCount.toLocaleString('en-US')} ${imp.rowCount === 1 ? 'row' : 'rows'}`;
}

function ImportHeader({ imp, uploader }: { imp: ImportDetail; uploader: string | undefined }) {
  const name = importFileName(imp);
  return (
    <div className="bg-card border-b px-8 pt-4 pb-5">
      <nav aria-label="Breadcrumb" className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <BackToIntake />
        <span aria-hidden>/</span>
        <span>Asset list import</span>
      </nav>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="min-w-0 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{name}</h1>
        <LabelBadge label={imp.label} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:flex sm:flex-wrap">
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs font-semibold">Source</dt>
          <dd className="font-semibold">{imp.source}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs font-semibold">Rows</dt>
          <dd className="tabular-nums">{rowsText(imp)}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs font-semibold">Status</dt>
          <dd>
            <StatusBadge importStatus={imp.status} />
          </dd>
        </div>
        {imp.format ? (
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground text-xs font-semibold">Format</dt>
            <dd>{FORMAT_TEXT[imp.format]}</dd>
          </div>
        ) : null}
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs font-semibold">Uploaded</dt>
          <dd>
            {formatMoment(imp.createdAt)}
            {uploader ? <span className="text-muted-foreground"> by {uploader}</span> : null}
          </dd>
        </div>
      </dl>
      <div className="mt-4">
        <ProcessFlow imp={imp} />
      </div>
    </div>
  );
}

/** The one page for an import that is missing or hidden: the same for every cause. */
function ImportNotFound() {
  return (
    <div className="px-8 py-10">
      <div className="bg-card mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border px-6 py-12 text-center">
        <span className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-full">
          <SearchX className="size-5" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">{IMPORT_NOT_FOUND_TEXT}</h1>
        <p className="text-muted-foreground text-sm">Check the address, or open the import from Data intake.</p>
        <div className="text-sm">
          <BackToIntake />
        </div>
      </div>
    </div>
  );
}

// ---- The states ------------------------------------------------------------------------------

function ReadingPanel({ imp }: { imp: ImportDetail }) {
  return (
    <Panel title="Reading the file" actions={<Refreshing />}>
      <div className="flex items-start gap-3 px-5 py-6">
        <LoaderCircle className="text-primary mt-0.5 size-5 shrink-0 animate-spin" aria-hidden />
        <div className="grid gap-1 text-sm">
          <p className="font-semibold">The file is being read.</p>
          <p className="text-muted-foreground max-w-[65ch]">
            Its columns, row count and first rows show here when it’s done, so you can match the columns to asset
            fields. Files from {imp.source} with a saved mapping that fits are imported straight away.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function ProgressPanel({ imp }: { imp: ImportDetail }) {
  const importing = imp.status === 'importing';
  return (
    <Panel title={importing ? 'Importing' : 'Queued'} actions={<Refreshing />}>
      <div className="grid gap-3 px-5 py-5">
        <p className="text-sm">
          {importing
            ? `Writing ${rowsText(imp)} into Assets and drawing their links. The results show here when it finishes.`
            : 'The import is waiting its turn. It starts as soon as the worker picks it up.'}
        </p>
        <div
          role="progressbar"
          aria-label={importing ? 'Importing' : 'Queued'}
          aria-valuetext={importing ? 'Importing' : 'Waiting to start'}
          className="bg-muted h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className={cn(
              'h-full rounded-full',
              importing ? 'bg-primary w-full animate-pulse' : 'bg-primary/35 w-1/6 animate-pulse',
            )}
          />
        </div>
      </div>
    </Panel>
  );
}

function FailedPanel({
  imp,
  onCheckAgain,
  checking,
}: {
  imp: ImportDetail;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const code = imp.errors?.[0]?.code;
  const readFailed = imp.columns === null;
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert aria-hidden />
      <AlertTitle>{readFailed ? 'This file couldn’t be read' : 'This import failed'}</AlertTitle>
      <AlertDescription>
        <p>{failureText(imp)}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {readFailed ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/intake">Upload a corrected file</Link>
            </Button>
          ) : null}
          {code === 'import_failed' ? (
            <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onCheckAgain}>
              <RefreshCw className={cn(checking && 'animate-spin')} aria-hidden />
              Check again
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

// ---- The mapping editor ----------------------------------------------------------------------

function PrefillNote({ imp }: { imp: ImportDetail }) {
  if (imp.mappingFrom === 'saved') {
    return (
      <Alert variant="info" role="note">
        <Info aria-hidden />
        <AlertTitle>Filled from the saved mapping for {imp.source}</AlertTitle>
        <AlertDescription>
          <p>Check each field before running the import.</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="info" role="note">
      <Info aria-hidden />
      <AlertTitle>Suggested from the column names</AlertTitle>
      <AlertDescription>
        <p>
          {imp.savedMapping
            ? `The saved mapping for ${imp.source} names columns this file doesn’t have, so fields were matched to columns with similar names. Check each one.`
            : 'Fields were matched to columns with similar names. Check each one, and choose columns for the rest.'}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function MappingEditor({
  imp,
  canImport,
  pending,
  title,
  onRun,
  onCancel,
}: {
  imp: ImportDetail;
  canImport: boolean;
  pending: boolean;
  title: string;
  onRun: (input: RunInput) => void;
  /** Shown as a Cancel button when the editor was opened on purpose (a re-run). */
  onCancel?: (() => void) | undefined;
}) {
  const columns = imp.columns ?? [];
  const sample = sampleRows(imp);
  const [draft, setDraft] = useState<MappingDraft>(() => draftFrom(imp));
  const [saveForSource, setSaveForSource] = useState(true);
  const [tried, setTried] = useState(false);
  const problems = tried ? draftProblems(draft) : {};

  const onChange = (field: AssetImportField, column: string) => setDraft((d) => ({ ...d, [field]: column }));

  const run = () => {
    setTried(true);
    const found = draftProblems(draft);
    const first = Object.keys(found)[0] as AssetImportField | undefined;
    if (first) {
      document.getElementById(fieldSelectId(first))?.focus();
      return;
    }
    onRun({ draft, saveForSource });
  };

  const problemCount = Object.keys(problems).length;

  return (
    <>
      <Panel
        title={title}
        actions={
          onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          ) : null
        }
      >
        <div className="px-5 pt-4 pb-3">
          <PrefillNote imp={imp} />
        </div>
        <MappingTable
          columns={columns}
          sample={sample}
          source={imp.source}
          draft={draft}
          onChange={onChange}
          problems={problems}
          disabled={pending}
        />
        <div className="bg-muted/40 flex flex-wrap items-center gap-x-6 gap-y-3 border-t px-5 py-4">
          {canImport ? (
            <>
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <Checkbox
                  id="save-for-source"
                  className="mt-0.5"
                  checked={saveForSource}
                  disabled={pending}
                  onCheckedChange={(v) => setSaveForSource(v === true)}
                  aria-describedby="save-for-source-hint"
                />
                <div className="grid gap-1">
                  <Label htmlFor="save-for-source">Save this mapping for {imp.source}</Label>
                  <p id="save-for-source-hint" className="text-muted-foreground max-w-[60ch] text-xs">
                    {imp.savedMapping ? `It replaces the saved mapping for ${imp.source}. ` : ''}
                    Later files from {imp.source} with these columns are then imported without this step.
                  </p>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                {problemCount > 0 ? (
                  <p className="text-destructive text-xs font-semibold" role="alert">
                    {problemCount === 1 ? 'One field needs attention.' : `${problemCount} fields need attention.`}
                  </p>
                ) : null}
                <Button type="button" onClick={run} disabled={pending}>
                  {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                  {pending ? 'Starting…' : 'Run import'}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground flex items-start gap-2 text-sm">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Only {importRolesText()} can run an import. You can look at the columns and sample rows, and ask one of
                them to run it.
              </span>
            </p>
          )}
        </div>
      </Panel>
      <SamplePreview columns={columns} sample={sample} draft={draft} rowCount={imp.rowCount} />
    </>
  );
}

// ---- The page --------------------------------------------------------------------------------

export function ImportPage({ id }: { id: string }) {
  const me = useMe();
  const role = me.data?.role;
  const canImport = role !== undefined && canImportAssets(role);
  const people = usePeople();
  const query = useImportDetail(id);
  const run = useRunImport(id);
  /** A finished or failed import opened again for another run. */
  const [rerun, setRerun] = useState(false);

  // A "busy" or other run refusal stops mattering once the import it was about has finished.
  const status = query.data?.status;
  const previous = useRef(status);
  const resetRun = run.reset;
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was !== undefined && status !== undefined && IMPORT_MOVING.has(was) && !IMPORT_MOVING.has(status)) {
      resetRun();
    }
  }, [status, resetRun]);

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the import…</span>
      </div>
    );
  }

  if (query.isError && query.error instanceof ApiError && query.error.status === 404) return <ImportNotFound />;

  if (query.isError && query.error instanceof ApiError && query.error.status === 403) {
    return (
      <>
        <div className="bg-card border-b px-8 pt-4 pb-5">
          <nav aria-label="Breadcrumb" className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
            <BackToIntake />
            <span aria-hidden>/</span>
            <span>Asset list import</span>
          </nav>
          <h1 className="text-xl font-semibold tracking-tight">Asset list import</h1>
        </div>
        <IntakeNoAccess role={role} />
      </>
    );
  }

  if (!query.data) {
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-muted-foreground text-xs">
          <BackToIntake />
        </div>
        <ApiProblem error={query.error} title="This import couldn’t be opened" />
      </div>
    );
  }

  const imp = query.data;
  const uploaderName = (people.data ?? []).find((p) => p.id === imp.createdBy)?.name;

  const startRun = (input: RunInput) =>
    run.mutate(input, {
      onSuccess: () => setRerun(false),
    });

  const problem = run.isError ? runProblem(run.error, imp.source) : null;
  const stale = run.error instanceof ApiError && run.error.code === 'stale_version';
  const reload = async () => {
    run.reset();
    await query.refetch();
  };

  const editorKey = `${imp.id}:${imp.mappingFrom}:${imp.savedMapping?.version ?? 0}:${imp.updatedAt}`;
  const mappable = imp.columns !== null;

  let body: ReactNode;
  switch (imp.status) {
    case 'reading':
      body = <ReadingPanel imp={imp} />;
      break;
    case 'needs_mapping':
      body = (
        <MappingEditor
          key={editorKey}
          imp={imp}
          canImport={canImport}
          pending={run.isPending}
          title="Match the file’s columns to asset fields"
          onRun={startRun}
        />
      );
      break;
    case 'queued':
    case 'importing':
      body = (
        <>
          <ProgressPanel imp={imp} />
          {mappable ? (
            <SamplePreview columns={imp.columns ?? []} sample={sampleRows(imp)} rowCount={imp.rowCount} />
          ) : null}
        </>
      );
      break;
    case 'done':
      body = (
        <>
          <ImportResults
            imp={imp}
            footer={
              canImport && mappable && !rerun ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setRerun(true)}>
                  <RotateCcw aria-hidden />
                  Run again
                </Button>
              ) : null
            }
          />
          {rerun ? (
            <MappingEditor
              key={editorKey}
              imp={imp}
              canImport={canImport}
              pending={run.isPending}
              title="Run the import again"
              onRun={startRun}
              onCancel={() => {
                run.reset();
                setRerun(false);
              }}
            />
          ) : null}
        </>
      );
      break;
    case 'failed':
      body = (
        <>
          <FailedPanel imp={imp} checking={query.isFetching} onCheckAgain={() => void query.refetch()} />
          {mappable && canImport ? (
            <MappingEditor
              key={editorKey}
              imp={imp}
              canImport={canImport}
              pending={run.isPending}
              title="Choose the columns and run it again"
              onRun={startRun}
            />
          ) : null}
        </>
      );
      break;
  }

  return (
    <>
      <ImportHeader imp={imp} uploader={uploaderName} />
      <div className="flex min-w-0 flex-col gap-5 px-8 py-6">
        {query.isError ? <ApiProblem error={query.error} title="The latest status couldn’t be checked" /> : null}
        {problem ? (
          <ApiProblem error={problem.error} title={problem.title}>
            {stale ? (
              <Button type="button" size="sm" variant="outline" className="mt-1" onClick={() => void reload()}>
                <RefreshCw aria-hidden />
                Reload
              </Button>
            ) : null}
          </ApiProblem>
        ) : null}
        {run.isSuccess && IMPORT_MOVING.has(imp.status) ? (
          <Alert variant="info" role="status">
            <Check aria-hidden />
            <AlertDescription>
              <p>The import started. You can leave this page; it carries on, and its results stay here.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {body}
      </div>
    </>
  );
}
