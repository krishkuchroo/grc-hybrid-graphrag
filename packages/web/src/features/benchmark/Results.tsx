// A run's per-question results (S8-010), in the Analyst review screen's style (D2, S5-005): a tab per
// part the run measured, filters on mode, kind and outcome, a paged table in question order then
// mode (D47), and the chosen result's details in a side panel, stepping through the page's results.
// The filters and page live in the URL. A
// running run's results ask again every 10 s. A run above the reader's clearance shows the hidden
// words instead (D51).
import {
  BENCHMARK_OUTCOMES,
  BENCHMARK_PART_KINDS,
  BENCHMARK_PART_MODES,
  BENCHMARK_PARTS,
  benchmarkKindText,
  benchmarkModeText,
  benchmarkOutcomeText,
  benchmarkSkipReasonText,
  extractionLinkStateText,
  type BenchmarkItemKind,
  type BenchmarkMode,
  type BenchmarkOutcome,
  type BenchmarkPart,
  type GraphFallbackReason,
} from '@grc/shared';
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, ListChecks, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration } from '@/features/chat/words';
import { ApiProblem } from '@/features/records/ApiProblem';
import { LinkPhrase } from '@/features/review/ReviewBits';
import { cn } from '@/lib/utils';
import { HiddenNotice, ModeSwatch, OutcomeBadge } from './BenchmarkBits';
import { ResultDetail } from './ResultDetail';
import {
  RESULTS_PAGE_SIZE,
  useBenchmarkResults,
  type BenchmarkRunSearch,
  type ExtractionResult,
  type QuestionResult,
  type ResultRow,
  type RunDetail,
} from './useBenchmark';
import { formatScore } from './words';

const PART_TAB_TEXT: Record<BenchmarkPart, string> = {
  retrieval: 'Searches',
  answers: 'Answers',
  extraction: 'Extraction',
};

/** A fallback reason in a few words, for the table; the details say it in full. */
const FALLBACK_SHORT: Record<GraphFallbackReason, string> = {
  graph_model_unavailable: 'Model unreachable',
  graph_query_invalid: 'Not in the expected form',
  graph_query_refused: 'Refused by the checks',
  graph_query_timed_out: 'Timed out',
  graph_query_failed: 'Failed',
};

function rowKey(row: ResultRow): string {
  return `${row.part}|${row.mode}|${row.itemKey}`;
}

/** The score a question's row shows: the one that says most about its kind and part. */
function keyScore(row: QuestionResult): { label: string; text: string } {
  const m = row.metrics;
  if (row.part === 'retrieval')
    return { label: 'Context recall', text: formatScore('context_recall', m.context_recall) };
  if (row.kind === 'no_answer') {
    const v = m.no_answer_correct;
    return { label: 'No-answer rule', text: typeof v === 'number' ? (v >= 1 ? 'Kept' : 'Broken') : '—' };
  }
  if (row.kind === 'injection_trap' && typeof m.injection_followed === 'number') {
    return { label: 'Planted instruction', text: m.injection_followed >= 1 ? 'Followed' : 'Resisted' };
  }
  return { label: 'Answer correctness', text: formatScore('answer_correctness', m.answer_correctness) };
}

function GraphCell({ row }: { row: QuestionResult }) {
  const graph = row.details.graph;
  if (row.mode === 'vector' || !graph) return <span className="text-muted-foreground">—</span>;
  if (graph.ran) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap text-[#1f5c38]">
        <CircleCheck className="size-3.5" aria-hidden />
        Ran
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1 text-xs">
      <CircleX className="mt-px size-3.5 shrink-0 text-[#8f1f15]" aria-hidden />
      <span>
        <span className="font-semibold">Fell back</span>
        {graph.fallback ? <span className="text-muted-foreground block">{FALLBACK_SHORT[graph.fallback]}</span> : null}
      </span>
    </span>
  );
}

function SelectButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="hover:text-primary focus-visible:ring-ring/50 block w-full rounded-sm text-left outline-none focus-visible:ring-[3px]"
    >
      {children}
    </button>
  );
}

function QuestionRows({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly QuestionResult[];
  selected: string | null;
  onSelect: (row: ResultRow) => void;
}) {
  return (
    <Table>
      <TableHeader className="bg-muted/70">
        <TableRow>
          <TableHead className="pl-4">Question</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Graph</TableHead>
          <TableHead className="pr-4 text-right">Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = rowKey(row);
          const score = keyScore(row);
          const isSelected = key === selected;
          return (
            <TableRow
              key={key}
              data-state={isSelected ? 'selected' : undefined}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a, button')) return;
                onSelect(row);
              }}
              className={cn(
                'even:bg-muted/30 hover:bg-accent/60 cursor-pointer',
                isSelected && 'bg-accent even:bg-accent shadow-[inset_3px_0_0_var(--primary)]',
              )}
            >
              <TableCell className="max-w-[26rem] min-w-[16rem] pl-4 align-top whitespace-normal">
                <SelectButton selected={isSelected} onSelect={() => onSelect(row)}>
                  <span className="text-muted-foreground block text-xs">
                    {row.itemKey}, {benchmarkKindText(row.kind)}
                  </span>
                  <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{row.details.question}</span>
                </SelectButton>
              </TableCell>
              <TableCell className="align-top">
                <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
                  <ModeSwatch mode={row.mode} />
                  {benchmarkModeText(row.mode)}
                </span>
              </TableCell>
              <TableCell className="align-top">
                <span className="grid justify-items-start gap-1">
                  <OutcomeBadge outcome={row.outcome} />
                  {row.outcome === 'skipped' && row.details.reason ? (
                    <span className="text-muted-foreground max-w-[10rem] text-xs leading-snug whitespace-normal">
                      {benchmarkSkipReasonText(row.details.reason)}
                    </span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="align-top">
                <span className="grid">
                  <span className="font-semibold tabular-nums">{score.text}</span>
                  <span className="text-muted-foreground text-xs">{score.label}</span>
                </span>
              </TableCell>
              <TableCell className="align-top">
                <GraphCell row={row} />
              </TableCell>
              <TableCell className="pr-4 text-right align-top tabular-nums">
                {formatDuration(row.details.timings.totalMs)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function EndText({ end }: { end: { number: string | null; name: string } }) {
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {end.number ? <span className="font-semibold tabular-nums">{end.number} </span> : null}
      {end.name}
    </span>
  );
}

function ExtractionRows({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly ExtractionResult[];
  selected: string | null;
  onSelect: (row: ResultRow) => void;
}) {
  return (
    <Table>
      <TableHeader className="bg-muted/70">
        <TableRow>
          <TableHead className="pl-4">Link</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Where it stands</TableHead>
          <TableHead className="pr-4">Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = rowKey(row);
          const isSelected = key === selected;
          return (
            <TableRow
              key={key}
              data-state={isSelected ? 'selected' : undefined}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a, button')) return;
                onSelect(row);
              }}
              className={cn(
                'even:bg-muted/30 hover:bg-accent/60 cursor-pointer',
                isSelected && 'bg-accent even:bg-accent shadow-[inset_3px_0_0_var(--primary)]',
              )}
            >
              <TableCell className="max-w-[28rem] min-w-[18rem] pl-4 align-top whitespace-normal">
                <SelectButton selected={isSelected} onSelect={() => onSelect(row)}>
                  <LinkPhrase
                    from={<EndText end={row.details.from} />}
                    type={row.details.linkType}
                    to={<EndText end={row.details.to} />}
                  />
                </SelectButton>
              </TableCell>
              <TableCell className="align-top text-sm">{benchmarkKindText(row.kind)}</TableCell>
              <TableCell className="align-top text-sm">{extractionLinkStateText(row.details.state)}</TableCell>
              <TableCell className="pr-4 align-top">
                <OutcomeBadge outcome={row.outcome} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function Results({
  run,
  search,
  onSearchChange,
}: {
  run: RunDetail;
  search: BenchmarkRunSearch;
  onSearchChange: (next: BenchmarkRunSearch) => void;
}) {
  const parts = BENCHMARK_PARTS.filter((p) => run.parts.includes(p));
  const part: BenchmarkPart = search.part && parts.includes(search.part) ? search.part : (parts[0] ?? 'retrieval');
  const modes = BENCHMARK_PART_MODES[part].filter((m) => run.modes.includes(m));
  const kinds = BENCHMARK_PART_KINDS[part];
  const mode = search.mode && modes.includes(search.mode) ? search.mode : undefined;
  const kind = search.kind && kinds.includes(search.kind) ? search.kind : undefined;
  const outcome = search.outcome;
  const page = search.page ?? 1;

  const results = useBenchmarkResults(
    run.id,
    { part, mode, kind, outcome, page },
    { enabled: !run.hidden && parts.length > 0, running: run.status === 'running' },
  );
  const [selected, setSelected] = useState<ResultRow | null>(null);

  const items = results.data?.items ?? [];
  const selectedKey = selected ? rowKey(selected) : null;
  // The chosen row as the latest answer has it (a running run's rows fill in), or as it was chosen.
  const shownRow = (selectedKey && items.find((row) => rowKey(row) === selectedKey)) || selected;
  const chosen = shownRow && shownRow.part === part ? shownRow : null;

  const filtered = mode !== undefined || kind !== undefined || outcome !== undefined;
  const change = (patch: Partial<BenchmarkRunSearch>) => {
    const next: BenchmarkRunSearch = { ...search, ...patch };
    delete next.page;
    for (const key of Object.keys(next) as Array<keyof BenchmarkRunSearch>) {
      if (next[key] === undefined) delete next[key];
    }
    setSelected(null);
    onSearchChange(next);
  };
  const changePart = (next: BenchmarkPart) => {
    const out: BenchmarkRunSearch = {};
    if (next !== parts[0]) out.part = next;
    setSelected(null);
    onSearchChange(out);
  };

  const total = results.data?.total ?? 0;
  const first = total === 0 ? 0 : (page - 1) * RESULTS_PAGE_SIZE + 1;
  const last = Math.min(page * RESULTS_PAGE_SIZE, total);

  let body: ReactNode;
  if (run.hidden || results.data?.hidden) {
    body = (
      <div className="p-5">
        <HiddenNotice />
      </div>
    );
  } else if (results.isError && !results.data) {
    body = (
      <div className="p-5">
        <ApiProblem error={results.error} title="The results couldn’t be shown" />
      </div>
    );
  } else if (results.isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-14 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading results…</span>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
          <ListChecks className="size-5" aria-hidden />
        </span>
        {filtered ? (
          <>
            <p className="max-w-md text-sm">No results match these filters.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => change({ mode: undefined, kind: undefined, outcome: undefined })}
            >
              Clear filters
            </Button>
          </>
        ) : (
          <p className="max-w-md text-sm">
            {run.status === 'running'
              ? `No ${PART_TAB_TEXT[part].toLowerCase()} results yet. They appear here as the run stores them.`
              : `This run stored no ${PART_TAB_TEXT[part].toLowerCase()} results.`}
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <div className={cn('min-w-0 overflow-x-auto', results.isPlaceholderData && 'opacity-60')}>
        {part === 'extraction' ? (
          <ExtractionRows
            rows={items.filter((r): r is ExtractionResult => r.part === 'extraction')}
            selected={chosen ? rowKey(chosen) : null}
            onSelect={setSelected}
          />
        ) : (
          <QuestionRows
            rows={items.filter((r): r is QuestionResult => r.part !== 'extraction')}
            selected={chosen ? rowKey(chosen) : null}
            onSelect={setSelected}
          />
        )}
      </div>
    );
  }

  const at = chosen ? items.findIndex((row) => rowKey(row) === rowKey(chosen)) : -1;
  const previous = at > 0 ? items[at - 1] : undefined;
  const next = at >= 0 && at < items.length - 1 ? items[at + 1] : undefined;

  return (
    <section aria-labelledby="results" className="bg-card min-w-0 rounded-lg border shadow-xs">
      <header className="flex min-h-11 items-center gap-3 border-b px-5 py-2.5">
        <h2 id="results" className="text-sm font-semibold">
          Results, question by question
        </h2>
      </header>
      {run.hidden ? null : (
        <>
          {parts.length > 1 ? (
            <nav aria-label="Parts" className="flex overflow-x-auto border-b px-2">
              {parts.map((p) => {
                const isActive = p === part;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => changePart(p)}
                    className={cn(
                      'relative -mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm whitespace-nowrap outline-none',
                      'focus-visible:ring-ring/50 rounded-t-sm focus-visible:ring-[3px] focus-visible:ring-inset',
                      isActive
                        ? 'border-primary text-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground border-transparent',
                    )}
                  >
                    {PART_TAB_TEXT[p]}
                  </button>
                );
              })}
            </nav>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            {modes.length > 1 ? (
              <NativeSelect
                aria-label="Mode"
                className="w-40"
                value={mode ?? ''}
                onChange={(event) => change({ mode: (event.target.value || undefined) as BenchmarkMode | undefined })}
              >
                <option value="">Both modes</option>
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {benchmarkModeText(m)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <NativeSelect
              aria-label="Kind"
              className="w-52"
              value={kind ?? ''}
              onChange={(event) => change({ kind: (event.target.value || undefined) as BenchmarkItemKind | undefined })}
            >
              <option value="">Every kind</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {benchmarkKindText(k)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Outcome"
              className="w-40"
              value={outcome ?? ''}
              onChange={(event) =>
                change({ outcome: (event.target.value || undefined) as BenchmarkOutcome | undefined })
              }
            >
              <option value="">Every outcome</option>
              {BENCHMARK_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {benchmarkOutcomeText(o)}
                </option>
              ))}
            </NativeSelect>
            {filtered ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => change({ mode: undefined, kind: undefined, outcome: undefined })}
              >
                <X aria-hidden />
                Clear
              </Button>
            ) : null}
            <span className="text-muted-foreground ml-auto text-xs">
              {part === 'extraction'
                ? 'Choose a link to see both its ends, where it stands and its plant.'
                : 'Choose a question to see its expected records, answer and graph query.'}
            </span>
          </div>
        </>
      )}

      {body}

      {!run.hidden && results.data && !results.data.hidden && total > 0 ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-sm">
          <p>
            <span className="text-foreground font-semibold tabular-nums">
              {first}–{last}
            </span>{' '}
            of <span className="text-foreground font-semibold tabular-nums">{total}</span> results
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => {
                const next: BenchmarkRunSearch = { ...search, page: page - 1 };
                if (page - 1 <= 1) delete next.page;
                setSelected(null);
                onSearchChange(next);
              }}
            >
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={last >= total}
              onClick={() => {
                setSelected(null);
                onSearchChange({ ...search, page: page + 1 });
              }}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={chosen !== null} onOpenChange={(open) => (open ? undefined : setSelected(null))}>
        <DialogContent className="animate-panel-in top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-xl">
          {chosen ? (
            <>
              <div className="border-b px-5 py-3.5 pr-12">
                <DialogTitle className="text-base">
                  {chosen.part === 'extraction' ? 'Extraction item' : 'Question'} {chosen.itemKey}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {chosen.part === 'extraction'
                    ? 'The link, both its ends, where it stands in the org and the plant it comes from.'
                    : 'The question, the expected records and which were found, the answer, the graph query and the times.'}
                </DialogDescription>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ResultDetail row={chosen} />
              </div>
              <div className="flex items-center gap-2 border-t px-5 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!previous}
                  onClick={() => previous && setSelected(previous)}
                >
                  <ChevronLeft aria-hidden />
                  Previous result
                </Button>
                <span className="text-muted-foreground mx-auto text-xs tabular-nums">
                  {at >= 0 ? `${first + at} of ${total}` : null}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!next}
                  onClick={() => next && setSelected(next)}
                >
                  Next result
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
