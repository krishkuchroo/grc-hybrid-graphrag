// The Benchmark screen's data (S8-010, D27 #13), around the generated typed client (D30): the org's
// runs, newest first and paged (GET /api/v1/benchmark/runs), one run with its settings and summary
// (GET /api/v1/benchmark/runs/:id) and its results, paged and filtered (GET …/:id/results). Only the
// org's Admins may read them (D50 `admin` cell); the API checks that, the org wall and the run's label
// (D51), and these hooks only fetch, refresh and shape what comes back.
// - Each answer is read with the shared benchmark schemas the API answers with (@grc/shared), so the
//   screen works with the exact shapes: the summary groups, the settings' records and every nullable
//   text, which the generated client types loosely.
// - A running run, its results and a list holding one ask again every 10 s, so progress shows without
//   a reload; nothing polls once every run shown has ended.
// - A record number in the results carries no record ID, so opening it looks the number up in its
//   kind's list (the lists match numbers), as the person, and opens the record's page.
import {
  BENCHMARK_ITEM_KINDS,
  BENCHMARK_MODES,
  BENCHMARK_OUTCOMES,
  BENCHMARK_PARTS,
  BENCHMARK_RUN_STATUSES,
  RECORD_KINDS,
  benchmarkQuestionsDone,
  benchmarkResultsPageSchema,
  benchmarkRunDetailSchema,
  benchmarkRunsPageSchema,
  can,
  type BenchmarkItemKind,
  type BenchmarkMode,
  type BenchmarkOutcome,
  type BenchmarkPart,
  type BenchmarkResultRow,
  type BenchmarkResultsPage,
  type BenchmarkRunDetail,
  type BenchmarkRunRow,
  type BenchmarkRunStatus,
  type BenchmarkRunsPage,
  type RecordKind,
} from '@grc/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type ListQuery } from '@/api/client';

export type RunRow = BenchmarkRunRow;
export type RunDetail = BenchmarkRunDetail;
export type VisibleRun = Extract<RunDetail, { hidden: false }>;
export type ResultRow = BenchmarkResultRow;
export type QuestionResult = Extract<ResultRow, { part: 'retrieval' | 'answers' }>;
export type ExtractionResult = Extract<ResultRow, { part: 'extraction' }>;

/** A running run asks again this often. */
export const REFRESH_MS = 10_000;
/** A running run with no new results for this long says "No progress since …". */
export const STALLED_AFTER_MS = 30 * 60_000;

export const RUNS_PAGE_SIZE = 20;
export const RESULTS_PAGE_SIZE = 25;

export const benchmarkKeys = {
  all: ['benchmark'] as const,
  runs: (query: ListQuery) => ['benchmark', 'runs', query] as const,
  run: (id: string) => ['benchmark', 'run', id] as const,
  results: (id: string, query: ListQuery) => ['benchmark', 'results', id, query] as const,
  extractionCount: (id: string) => ['benchmark', 'extraction-count', id] as const,
  recordId: (kind: string, number: string) => ['benchmark', 'record-id', kind, number] as const,
};

/** Whether the role may open the Benchmark screen: the `admin` cell (D50, S8-Q1). */
export function canViewBenchmark(role: string | undefined): boolean {
  return role !== undefined && can(role, 'admin', 'view');
}

/** True for the API's "you can't use this screen" answer. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** True for a run that doesn't exist or is another org's. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Retries only what may pass on a second try: never a refusal. */
function retry(count: number, err: unknown): boolean {
  return !(err instanceof ApiError && err.status < 500) && count < 2;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function pageOf(value: unknown): number | undefined {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 ? page : undefined;
}

// ---- The runs list -------------------------------------------------------------------------------

/** The runs list's state in the URL, left out when it is the default (every run, page 1). */
export interface BenchmarkListSearch {
  status?: BenchmarkRunStatus;
  part?: BenchmarkPart;
  page?: number;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the list fail. */
export function validateBenchmarkListSearch(raw: Record<string, unknown>): BenchmarkListSearch {
  const out: BenchmarkListSearch = {};
  const status = oneOf(BENCHMARK_RUN_STATUSES, raw.status);
  if (status) out.status = status;
  const part = oneOf(BENCHMARK_PARTS, raw.part);
  if (part) out.part = part;
  const page = pageOf(raw.page);
  if (page) out.page = page;
  return out;
}

function runsQuery(search: BenchmarkListSearch): ListQuery {
  return { page: search.page ?? 1, pageSize: RUNS_PAGE_SIZE, status: search.status, part: search.part };
}

/** One page of the org's runs, newest first; asked again every 10 s while one on it is running. */
export function useBenchmarkRuns(search: BenchmarkListSearch, enabled: boolean) {
  const query = runsQuery(search);
  return useQuery({
    queryKey: benchmarkKeys.runs(query),
    queryFn: async (): Promise<BenchmarkRunsPage> => benchmarkRunsPageSchema.parse(await api.getBenchmarkRuns(query)),
    placeholderData: keepPreviousData,
    enabled,
    retry,
    refetchInterval: (q) => (q.state.data?.items.some((run) => run.status === 'running') ? REFRESH_MS : false),
  });
}

// ---- One run --------------------------------------------------------------------------------------

/** One run with its settings (when the reader's clearance reaches its label) and its summary;
 * asked again every 10 s while it runs. */
export function useBenchmarkRun(id: string, enabled: boolean) {
  return useQuery({
    queryKey: benchmarkKeys.run(id),
    queryFn: async (): Promise<RunDetail> => benchmarkRunDetailSchema.parse(await api.getBenchmarkRunsId({ id })),
    enabled,
    retry,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? REFRESH_MS : false),
  });
}

/** The run page's results filters in the URL. `part` is left out for the run's first part. */
export interface BenchmarkRunSearch {
  part?: BenchmarkPart;
  mode?: BenchmarkMode;
  kind?: BenchmarkItemKind;
  outcome?: BenchmarkOutcome;
  page?: number;
}

/** Keeps only what the API accepts, so a hand-edited address can't make the results fail. */
export function validateBenchmarkRunSearch(raw: Record<string, unknown>): BenchmarkRunSearch {
  const out: BenchmarkRunSearch = {};
  const part = oneOf(BENCHMARK_PARTS, raw.part);
  if (part) out.part = part;
  const mode = oneOf(BENCHMARK_MODES, raw.mode);
  if (mode) out.mode = mode;
  const kind = oneOf(BENCHMARK_ITEM_KINDS, raw.kind);
  if (kind) out.kind = kind;
  const outcome = oneOf(BENCHMARK_OUTCOMES, raw.outcome);
  if (outcome) out.outcome = outcome;
  const page = pageOf(raw.page);
  if (page) out.page = page;
  return out;
}

/** One page of a run's results for one part, in question order then mode; asked again every 10 s
 * while the run runs. A run above the reader's label answers `hidden` with no items. */
export function useBenchmarkResults(
  id: string,
  filters: { part: BenchmarkPart } & Omit<BenchmarkRunSearch, 'part'>,
  options: { enabled: boolean; running: boolean },
) {
  const query: ListQuery = {
    page: filters.page ?? 1,
    pageSize: RESULTS_PAGE_SIZE,
    part: filters.part,
    mode: filters.mode,
    kind: filters.kind,
    outcome: filters.outcome,
  };
  return useQuery({
    queryKey: benchmarkKeys.results(id, query),
    queryFn: async (): Promise<BenchmarkResultsPage> =>
      benchmarkResultsPageSchema.parse(await api.getBenchmarkRunsIdResults({ id }, query)),
    placeholderData: keepPreviousData,
    enabled: options.enabled,
    retry,
    refetchInterval: options.running ? REFRESH_MS : false,
  });
}

/**
 * "Running: N of M questions" for a running run. The run's result count holds its extraction items
 * too, which aren't questions, so for a run with that part they are counted (one item a page) and
 * taken off. A run above the reader's label has no results to count; its own count is used.
 */
export function useQuestionProgress(run: RunRow | undefined): { done: number; total: number } | null {
  const running = run?.status === 'running';
  const withExtraction = running && run.parts.includes('extraction') && run.questionCount > 0;
  const extraction = useQuery({
    queryKey: benchmarkKeys.extractionCount(run?.id ?? 'none'),
    queryFn: async () =>
      benchmarkResultsPageSchema.parse(
        await api.getBenchmarkRunsIdResults({ id: run?.id ?? '' }, { part: 'extraction', pageSize: 1 }),
      ),
    enabled: withExtraction,
    retry: false,
    refetchInterval: withExtraction ? REFRESH_MS : false,
  });
  if (!running) return null;
  const extractionItems = withExtraction && extraction.data && !extraction.data.hidden ? extraction.data.total : 0;
  return {
    done: benchmarkQuestionsDone(
      Math.max(0, run.resultCount - extractionItems),
      run.parts,
      run.modes,
      run.questionCount,
    ),
    total: run.questionCount,
  };
}

/** The time now, moved on every `everyMs` while `enabled` (for "No progress since …"). */
export function useNow(everyMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs, enabled]);
  return now;
}

/** Whether a running run has gone 30 minutes without new results. */
export function isStalled(run: RunRow, now: number): boolean {
  if (run.status !== 'running') return false;
  const last = new Date(run.lastActivityAt).getTime();
  return Number.isFinite(last) && now - last >= STALLED_AFTER_MS;
}

// ---- Record numbers -------------------------------------------------------------------------------

/** The kinds a number can be opened for: those with a page that can be found by number. Evidence is
 * shown on its control's page, so it has none. */
export const OPENABLE_KINDS = [...RECORD_KINDS, 'audit_finding', 'framework', 'requirement'] as const;
export type OpenableKind = (typeof OPENABLE_KINDS)[number];

export function isOpenableKind(kind: string): kind is OpenableKind {
  return (OPENABLE_KINDS as readonly string[]).includes(kind);
}

const NUMBER_LISTS: Record<
  RecordKind,
  (query: ListQuery) => Promise<{ items: Array<{ id: string; number: string }> }>
> = {
  risk: api.getRisks,
  control: api.getControls,
  policy: api.getPolicies,
  asset: api.getAssets,
  incident: api.getIncidents,
};

/** The first item whose number is exactly this one. */
function exact(items: ReadonlyArray<{ id: string; number: string }>, number: string): string | null {
  return items.find((item) => item.number === number)?.id ?? null;
}

/** A record's ID from its kind and number, as the person may see it; null when it is missing or
 * hidden from them (the same answer for both, D51). */
async function findRecordId(kind: OpenableKind, number: string): Promise<string | null> {
  const lookup = { q: number, status: 'all', pageSize: 10 } satisfies ListQuery;
  try {
    if (kind === 'audit_finding') return exact((await api.getAuditFindings(lookup)).items, number);
    if (kind === 'framework') return exact((await api.getFrameworks()).items, number);
    if (kind === 'requirement') {
      for (const framework of (await api.getFrameworks()).items) {
        const found = exact((await api.getFrameworksIdRequirements({ id: framework.id }, lookup)).items, number);
        if (found) return found;
      }
      return null;
    }
    return exact((await NUMBER_LISTS[kind](lookup)).items, number);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/** The query for a record number's ID, run when it is opened and kept for 5 minutes. */
export function recordIdQuery(kind: OpenableKind, number: string) {
  return {
    queryKey: benchmarkKeys.recordId(kind, number),
    queryFn: () => findRecordId(kind, number),
    staleTime: 5 * 60_000,
  };
}
