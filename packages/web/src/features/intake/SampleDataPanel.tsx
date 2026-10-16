// The "Sample data" part of Data intake (S3-015, D27 #10, D213 (6)), shown to Admins only: what API
// keys (the synthetic data generators, D18 and D42, or any other connector) have sent to this org,
// grouped by source and key, and the `pnpm gen:data` commands that run the generators on the Mac.
// The generators are command-line tools (D36): nothing here starts one, and the panel calls only
// the two list routes, GET /api/v1/push/batches and GET /api/v1/documents. What each list holds is
// the API's answer, after its org wall, role and label checks (D7).
import { useQuery } from '@tanstack/react-query';
import type { DocumentKind, DocumentStatus, ImportStatus } from '@grc/shared';
import { Check, Copy, KeyRound, LoaderCircle, Lock, RefreshCw, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type GetPushBatchesResponse, type ListQuery } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { cn } from '@/lib/utils';
import { AppLink, importHref } from './DocumentsTable';
import { KIND_TEXT } from './permissions';
import { StatusBadge } from './StatusBadge';
import { REFRESH_MS, type DocumentItem } from './useDocuments';

/** One push batch as `GET /api/v1/push/batches` returns it. */
export type PushBatchItem = GetPushBatchesResponse['items'][number];

// ---------------------------------------------------------------------------------------------
// The generator commands (S3-018, S3-019). Full pipeline goes through the real API with a
// short-lived API key; fast load writes the large size straight into the databases (D42). The
// counts are the generators' own sizes (packages/generators/src/world/sizes.ts).
// ---------------------------------------------------------------------------------------------

export interface GeneratorRun {
  size: 'tiny' | 'accuracy' | 'stress';
  title: string;
  mode: 'full' | 'fast';
  command: string;
  /** What it makes. */
  makes: string;
  /** What it's for and how it gets in. */
  purpose: string;
}

export const GENERATOR_RUNS: readonly GeneratorRun[] = [
  {
    size: 'tiny',
    title: 'Tiny',
    mode: 'full',
    command: 'pnpm gen:data --mode full --size tiny',
    makes: '1 org with 30 assets, 10 risks, 15 controls, 3 policies and 10 incidents.',
    purpose: 'Sent through the API like a real connector. A quick look at the whole flow.',
  },
  {
    size: 'accuracy',
    title: 'Accuracy',
    mode: 'full',
    command: 'pnpm gen:data --mode full --size accuracy',
    makes: '2 orgs, each with 60 assets, 20 risks, 30 controls, 6 policies and 30 incidents.',
    purpose: 'Sent through the API, so extraction can be measured against a known answer key.',
  },
  {
    size: 'stress',
    title: 'Stress',
    mode: 'fast',
    command: 'pnpm gen:data --mode fast --size stress',
    makes: '20 orgs, each with 2,000 assets, 300 risks, 400 controls, 40 policies and 1,000 incidents.',
    purpose:
      'Fast load: written straight into the databases for search, chat and load tests. It skips the API, so it doesn’t show in the lists here.',
  },
];

const MODE_TEXT: Record<GeneratorRun['mode'], string> = {
  full: 'Through the API',
  fast: 'Fast load',
};

// ---------------------------------------------------------------------------------------------
// Reading the two lists and grouping them by source and key.
// ---------------------------------------------------------------------------------------------

/** Rows asked for per page (the API's most). */
export const LIST_PAGE_SIZE = 100;
/** Pages read per list, newest first: at most 1,000 batches and 1,000 files are looked at. */
export const MAX_LIST_PAGES = 10;

export interface AllPages<T> {
  items: T[];
  /** The list's total, as the API last gave it. */
  total: number;
  /** False when there were more than `MAX_LIST_PAGES` pages and only the newest were read. */
  complete: boolean;
}

/**
 * Reads a paged list page by page, newest first, until it ends or `maxPages` pages are read. An
 * item seen twice (the list moved on between pages) is kept once.
 */
export async function readAllPages<T extends { id: string }>(
  read: (query: { page: number; pageSize: number }) => Promise<{ items: T[]; total: number }>,
  maxPages: number = MAX_LIST_PAGES,
): Promise<AllPages<T>> {
  const seen = new Set<string>();
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const answer = await read({ page, pageSize: LIST_PAGE_SIZE });
    total = answer.total;
    for (const item of answer.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (answer.items.length < LIST_PAGE_SIZE || page * LIST_PAGE_SIZE >= answer.total) {
      return { items, total, complete: true };
    }
  }
  return { items, total, complete: false };
}

/** The key a source and an API key are grouped under. */
function groupKey(apiKeyId: string, source: string | null): string {
  return JSON.stringify([apiKeyId, source]);
}

function later(a: string, b: string): boolean {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(tb)) return !Number.isNaN(ta);
  if (Number.isNaN(ta)) return false;
  return ta > tb;
}

/** Newest first; the same moment falls back to source, then key, so the order never jumps. */
function byNewest<G extends { last: string; source: string | null; apiKeyId: string }>(a: G, b: G): number {
  if (later(a.last, b.last)) return -1;
  if (later(b.last, a.last)) return 1;
  const source = (a.source ?? '').localeCompare(b.source ?? '');
  return source !== 0 ? source : a.apiKeyId.localeCompare(b.apiKeyId);
}

export interface PushGroup {
  key: string;
  source: string;
  apiKeyId: string;
  /** Batches received from this source with this key. */
  batches: number;
  /** Rows across those batches. */
  rows: number;
  /** When the newest batch arrived. */
  last: string;
  /** The newest batch's import. */
  latest: { importId: string | null; importStatus: ImportStatus | null; errorCount: number | null };
  /** Batches whose rows matched an earlier batch's, so nothing new was stored or imported. */
  repeats: number;
  /** Batches whose import failed. */
  failed: number;
}

/** Push batches grouped by source and API key, newest group first. */
export function groupPushBatches(items: readonly PushBatchItem[]): PushGroup[] {
  const groups = new Map<string, PushGroup>();
  for (const batch of items) {
    const key = groupKey(batch.apiKeyId, batch.source);
    const importId = typeof batch.importId === 'string' ? batch.importId : null;
    const latest = { importId, importStatus: batch.importStatus, errorCount: batch.errorCount };
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        source: batch.source,
        apiKeyId: batch.apiKeyId,
        batches: 0,
        rows: 0,
        last: batch.createdAt,
        latest,
        repeats: 0,
        failed: 0,
      };
      groups.set(key, group);
    } else if (later(batch.createdAt, group.last)) {
      group.last = batch.createdAt;
      group.latest = latest;
    }
    group.batches += 1;
    group.rows += Number.isFinite(batch.rowCount) ? batch.rowCount : 0;
    if (batch.duplicate) group.repeats += 1;
    if (batch.importStatus === 'failed') group.failed += 1;
  }
  return [...groups.values()].sort(byNewest);
}

export interface UploadGroup {
  key: string;
  /** The source the key named, or null when it named none. */
  source: string | null;
  apiKeyId: string;
  files: number;
  /** When the newest file arrived. */
  last: string;
  /** Files per kind, most first. */
  kinds: Array<{ kind: DocumentKind; count: number }>;
  /** Files per status, in the order a file moves through them. */
  statuses: Array<{ status: DocumentStatus; count: number }>;
}

const STATUS_ORDER: readonly DocumentStatus[] = ['stored', 'processing', 'processed', 'failed', 'removed'];

/**
 * The documents API keys uploaded, grouped by source and key, newest group first. Files a push
 * batch brought in (`pushedDocumentIds`) are left out: they're listed with their batches.
 */
export function groupKeyUploads(
  documents: readonly DocumentItem[],
  pushedDocumentIds: ReadonlySet<string> = new Set(),
): UploadGroup[] {
  const groups = new Map<
    string,
    {
      source: string | null;
      apiKeyId: string;
      files: number;
      last: string;
      kinds: Map<DocumentKind, number>;
      statuses: Map<DocumentStatus, number>;
    }
  >();
  for (const document of documents) {
    if (document.uploader.type !== 'api_key' || pushedDocumentIds.has(document.id)) continue;
    const source = typeof document.source === 'string' && document.source.trim() !== '' ? document.source : null;
    const apiKeyId = document.uploader.id;
    const key = groupKey(apiKeyId, source);
    let group = groups.get(key);
    if (!group) {
      group = { source, apiKeyId, files: 0, last: document.createdAt, kinds: new Map(), statuses: new Map() };
      groups.set(key, group);
    } else if (later(document.createdAt, group.last)) {
      group.last = document.createdAt;
    }
    group.files += 1;
    group.kinds.set(document.kind, (group.kinds.get(document.kind) ?? 0) + 1);
    group.statuses.set(document.status, (group.statuses.get(document.status) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      source: g.source,
      apiKeyId: g.apiKeyId,
      files: g.files,
      last: g.last,
      kinds: [...g.kinds.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || KIND_TEXT[a.kind].localeCompare(KIND_TEXT[b.kind])),
      statuses: STATUS_ORDER.filter((s) => g.statuses.has(s)).map((status) => ({
        status,
        count: g.statuses.get(status) ?? 0,
      })),
    }))
    .sort(byNewest);
}

/** An import that moves on by itself; the panel asks again while one is. */
const IMPORT_MOVING: ReadonlySet<ImportStatus> = new Set(['reading', 'queued', 'importing']);

export const sampleDataKeys = {
  all: ['intake', 'sample-data'] as const,
  batches: ['intake', 'sample-data', 'push-batches'] as const,
  documents: ['intake', 'sample-data', 'documents'] as const,
};

/** The org's push batches and its documents, newest first, each read in full up to the cap. */
export function useSampleData() {
  const batches = useQuery({
    queryKey: sampleDataKeys.batches,
    queryFn: () => readAllPages<PushBatchItem>((q) => api.getPushBatches(q)),
    refetchInterval: (query) =>
      query.state.data?.items.some((b) => b.importStatus !== null && IMPORT_MOVING.has(b.importStatus))
        ? REFRESH_MS
        : false,
  });
  const documents = useQuery({
    queryKey: sampleDataKeys.documents,
    queryFn: () =>
      readAllPages<DocumentItem>((q) => api.getDocuments({ ...q, sort: '-createdAt' } satisfies ListQuery)),
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => d.uploader.type === 'api_key' && d.status === 'processing')
        ? REFRESH_MS
        : false,
  });

  const pushGroups = useMemo(() => groupPushBatches(batches.data?.items ?? []), [batches.data]);
  const pushedDocumentIds = useMemo(
    () => new Set((batches.data?.items ?? []).map((b) => b.documentId).filter((id) => id !== '')),
    [batches.data],
  );
  const uploadGroups = useMemo(
    () => groupKeyUploads(documents.data?.items ?? [], pushedDocumentIds),
    [documents.data, pushedDocumentIds],
  );
  const working =
    (batches.isFetched &&
      batches.data?.items.some((b) => b.importStatus !== null && IMPORT_MOVING.has(b.importStatus))) ||
    (documents.isFetched &&
      documents.data?.items.some((d) => d.uploader.type === 'api_key' && d.status === 'processing'));

  return { batches, documents, pushGroups, uploadGroups, working: Boolean(working) };
}

// ---------------------------------------------------------------------------------------------
// The screen.
// ---------------------------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('en-US');

function plural(count: number, one: string, many: string): string {
  return `${NUMBER.format(count)} ${count === 1 ? one : many}`;
}

/** An API key by the start of its ID; the full ID on hover. */
function KeyCell({ apiKeyId }: { apiKeyId: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`API key ${apiKeyId}`}>
      <KeyRound className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">API key </span>
      <span className="font-mono text-xs">{apiKeyId.slice(0, 8)}</span>
    </span>
  );
}

function Loading({ noun }: { noun: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-3 px-5 py-10 text-sm" role="status">
      <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
      <span>Loading {noun}…</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <p className="text-muted-foreground max-w-md text-sm">{children}</p>
    </div>
  );
}

function Capped({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return (
    <p className="text-muted-foreground border-t px-5 py-2 text-xs">
      Grouped from the newest {NUMBER.format(shown)} of {NUMBER.format(total)} {noun}.
    </p>
  );
}

function SubsectionHeader({ id, title, summary }: { id: string; title: string; summary?: string | undefined }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 pt-4 pb-2">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {summary ? <p className="text-muted-foreground text-xs">{summary}</p> : null}
    </div>
  );
}

function When({ value }: { value: string }) {
  return <span className="whitespace-nowrap">{formatMoment(value)}</span>;
}

function PushedTable({ groups }: { groups: PushGroup[] }) {
  return (
    <Table>
      <TableHeader className="bg-muted/70">
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>API key</TableHead>
          <TableHead className="text-right">Batches</TableHead>
          <TableHead className="text-right">Rows</TableHead>
          <TableHead>Last received</TableHead>
          <TableHead>Latest import</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => (
          <TableRow key={g.key} className="even:bg-muted/30 hover:bg-accent/60">
            <TableCell>
              <span className="font-semibold [overflow-wrap:anywhere]">{g.source}</span>
            </TableCell>
            <TableCell>
              <KeyCell apiKeyId={g.apiKeyId} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {NUMBER.format(g.batches)}
              {g.repeats > 0 ? (
                <span className="text-muted-foreground block text-xs">
                  {plural(g.repeats, 'repeat', 'repeats')} ignored
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">{NUMBER.format(g.rows)}</TableCell>
            <TableCell>
              <When value={g.last} />
            </TableCell>
            <TableCell>
              <div className="grid justify-items-start gap-0.5">
                {g.latest.importStatus === null ? (
                  <span className="text-muted-foreground text-sm">Not imported</span>
                ) : g.latest.importId ? (
                  <AppLink
                    href={importHref(g.latest.importId)}
                    className="hover:text-primary rounded-sm hover:underline focus-visible:underline"
                  >
                    <StatusBadge importStatus={g.latest.importStatus} />
                  </AppLink>
                ) : (
                  <StatusBadge importStatus={g.latest.importStatus} />
                )}
                {g.latest.errorCount ? (
                  <span className="text-muted-foreground text-xs">
                    {plural(g.latest.errorCount, 'row', 'rows')} with problems
                  </span>
                ) : null}
                {g.failed > 0 ? (
                  <span className="text-destructive text-xs">
                    {g.failed} of {plural(g.batches, 'batch', 'batches')} failed
                  </span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UploadedTable({ groups }: { groups: UploadGroup[] }) {
  return (
    <Table>
      <TableHeader className="bg-muted/70">
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>API key</TableHead>
          <TableHead className="text-right">Files</TableHead>
          <TableHead>Kinds</TableHead>
          <TableHead>Last uploaded</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => (
          <TableRow key={g.key} className="even:bg-muted/30 hover:bg-accent/60">
            <TableCell>
              {g.source ? (
                <span className="font-semibold [overflow-wrap:anywhere]">{g.source}</span>
              ) : (
                <span className="text-muted-foreground">No source named</span>
              )}
            </TableCell>
            <TableCell>
              <KeyCell apiKeyId={g.apiKeyId} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{NUMBER.format(g.files)}</TableCell>
            <TableCell>
              <ul className="grid gap-0.5">
                {g.kinds.map((k) => (
                  <li key={k.kind} className="whitespace-nowrap">
                    {KIND_TEXT[k.kind]}{' '}
                    <span className="text-muted-foreground tabular-nums">{NUMBER.format(k.count)}</span>
                  </li>
                ))}
              </ul>
            </TableCell>
            <TableCell>
              <When value={g.last} />
            </TableCell>
            <TableCell>
              <ul className="grid gap-0.5">
                {g.statuses.map((s) => (
                  <li key={s.status} className="flex items-center gap-1.5">
                    <StatusBadge documentStatus={s.status} />
                    <span className="text-muted-foreground text-sm tabular-nums">{NUMBER.format(s.count)}</span>
                  </li>
                ))}
              </ul>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One command, in a terminal line, with a copy button. */
function CommandLine({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = (next: 'copied' | 'selected') => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), next === 'copied' ? 2_000 : 6_000);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      settle('copied');
    } catch {
      // No clipboard (an older browser or a refused permission): select it to copy by hand.
      const code = codeRef.current;
      const selection = typeof window === 'undefined' ? null : window.getSelection();
      if (code && selection) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      settle('selected');
    }
  };

  return (
    <div className="grid gap-1">
      <div className="bg-chrome text-chrome-foreground flex min-w-0 items-start gap-2 rounded-md py-1 pr-1 pl-3">
        <span className="text-chrome-muted py-1.5 font-mono text-xs leading-4 select-none" aria-hidden>
          $
        </span>
        <code ref={codeRef} className="min-w-0 flex-1 py-1.5 font-mono text-xs leading-4 break-words">
          {command}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-chrome-foreground hover:bg-chrome-raised hover:text-chrome-foreground focus-visible:ring-brand/60 size-7 shrink-0"
          aria-label={`Copy the ${label} command`}
          title="Copy"
          onClick={() => void copy()}
        >
          {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
      <p className="text-muted-foreground min-h-4 text-xs" aria-live="polite">
        {state === 'copied'
          ? 'Copied. Paste it into Terminal on the Mac.'
          : state === 'selected'
            ? 'This browser couldn’t copy it. The command is selected: press Command-C.'
            : ''}
      </p>
    </div>
  );
}

function RunOnTheMac() {
  return (
    <aside
      aria-labelledby="sample-data-run"
      className="bg-muted/50 grid content-start gap-4 border-t px-5 py-4 xl:border-t-0 xl:border-l"
    >
      <div className="grid gap-1">
        <h3 id="sample-data-run" className="flex items-center gap-2 text-sm font-semibold">
          <TerminalSquare className="text-primary size-4" aria-hidden />
          Run a generator on the Mac
        </h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          The generators are command-line tools. Run one in Terminal on the Mac, from the project folder, while the
          stack is up. This screen can’t start them.
        </p>
      </div>
      <ul className="grid gap-4 md:grid-cols-3 md:gap-6 xl:grid-cols-1 xl:gap-4">
        {GENERATOR_RUNS.map((run) => (
          <li key={run.size} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold">{run.title}</span>
              <span className="text-muted-foreground text-xs">{MODE_TEXT[run.mode]}</span>
            </div>
            <p className="text-sm leading-snug">{run.makes}</p>
            <p className="text-muted-foreground text-xs leading-snug">{run.purpose}</p>
            <div className="mt-auto pt-0.5">
              <CommandLine command={run.command} label={run.title.toLowerCase()} />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground border-t pt-3 text-xs leading-relaxed">
        Each run makes its own orgs, named{' '}
        <span className="font-mono whitespace-nowrap">gen-&lt;seed&gt;-&lt;n&gt;</span>, with a short-lived API key for
        each that it revokes when it ends. Add{' '}
        <span className="font-mono whitespace-nowrap">--seed &lt;number&gt;</span> for a different made-up world; the
        same seed and size again adds nothing.
      </p>
    </aside>
  );
}

export function SampleDataPanel() {
  const { batches, documents, pushGroups, uploadGroups, working } = useSampleData();
  const refreshing = (batches.isFetching && !batches.isPending) || (documents.isFetching && !documents.isPending);

  const refresh = () => {
    void batches.refetch();
    void documents.refetch();
  };

  const batchTotal = batches.data?.items.length ?? 0;
  const uploadTotal = uploadGroups.reduce((n, g) => n + g.files, 0);

  let pushed: ReactNode;
  if (batches.isError && !batches.data) {
    pushed = (
      <div className="px-5 pb-4">
        <ApiProblem error={batches.error} title="The pushed batches couldn't be shown" />
      </div>
    );
  } else if (batches.isPending) {
    pushed = <Loading noun="pushed batches" />;
  } else if (pushGroups.length === 0) {
    pushed = <Empty>No API key has pushed an asset list to this org yet.</Empty>;
  } else {
    pushed = (
      <>
        <PushedTable groups={pushGroups} />
        {batches.data && !batches.data.complete ? (
          <Capped shown={batches.data.items.length} total={batches.data.total} noun="batches" />
        ) : null}
      </>
    );
  }

  let uploaded: ReactNode;
  if (documents.isError && !documents.data) {
    uploaded = (
      <div className="px-5 pb-4">
        <ApiProblem error={documents.error} title="The uploaded files couldn't be shown" />
      </div>
    );
  } else if (documents.isPending || (batches.isPending && !batches.isError)) {
    uploaded = <Loading noun="uploaded files" />;
  } else if (uploadGroups.length === 0) {
    uploaded = <Empty>No API key has uploaded a document to this org yet.</Empty>;
  } else {
    uploaded = (
      <>
        <UploadedTable groups={uploadGroups} />
        {documents.data && !documents.data.complete ? (
          <Capped shown={documents.data.items.length} total={documents.data.total} noun="files" />
        ) : null}
      </>
    );
  }

  return (
    <section aria-labelledby="sample-data-heading" className="bg-card rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3">
        <h2 id="sample-data-heading" className="text-sm font-semibold">
          Sample data
        </h2>
        <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
          <Lock className="size-3.5" aria-hidden />
          Only Admins see this part
        </p>
        <div className="ml-auto flex items-center gap-3">
          {working ? (
            <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Checking for updates every {REFRESH_MS / 1000} s
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing || batches.isPending || documents.isPending}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground border-b px-5 py-2.5 text-sm leading-relaxed">
        The synthetic data generators act like a customer’s connectors: they push asset lists and upload documents
        through the API with an API key. Everything API keys have sent to this org is listed here by source and key.
      </p>
      <div className="grid xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 pb-2">
          <section aria-labelledby="sample-data-pushed">
            <SubsectionHeader
              id="sample-data-pushed"
              title="Pushed asset lists"
              summary={
                batches.data && batchTotal > 0
                  ? `${plural(batchTotal, 'batch', 'batches')} from ${plural(pushGroups.length, 'source and key', 'sources and keys')}`
                  : undefined
              }
            />
            <div className="min-w-0">{pushed}</div>
          </section>
          <section aria-labelledby="sample-data-uploaded" className="mt-2 border-t">
            <SubsectionHeader
              id="sample-data-uploaded"
              title="Uploaded documents"
              summary={
                uploadTotal > 0
                  ? `${plural(uploadTotal, 'file', 'files')} from ${plural(uploadGroups.length, 'source and key', 'sources and keys')}`
                  : undefined
              }
            />
            <div className="min-w-0">{uploaded}</div>
          </section>
        </div>
        <RunOnTheMac />
      </div>
    </section>
  );
}
