// One result's details (S8-010), the evidence behind its scores:
// - a question: its text, its kind, part, mode and outcome (with why it was skipped or failed), its
//   scores, the expected records and which were found and in the context, the answer (when there is
//   one) with its citations, the graph query or why it fell back, the times, and the injection
//   check's result;
// - an extraction item: the link, both its ends, where it stands in the org and the plant it comes
//   from.
// Record numbers open their pages (as the reader may see them, D51).
import {
  BENCHMARK_ITEM_METRICS,
  BENCHMARK_METRIC_BY_NAME,
  benchmarkInjectionKindText,
  benchmarkKindText,
  benchmarkModeText,
  benchmarkPartText,
  benchmarkSkipReasonText,
  extractionLinkStateText,
  graphFallbackText,
  injectionCheckText,
  parseCatalogNumber,
  parseIntakeNumber,
  parseNumber,
  type BenchmarkCitation,
  type BenchmarkExpectedDetail,
  type BenchmarkFoundRecord,
} from '@grc/shared';
import {
  BookOpenText,
  CircleCheck,
  CircleDot,
  CircleX,
  EyeOff,
  FileText,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDuration, RECORD_KIND_TEXT } from '@/features/chat/words';
import { formatMoment } from '@/features/records/format';
import { LinkPhrase } from '@/features/review/ReviewBits';
import { cn } from '@/lib/utils';
import { ModeSwatch, OutcomeBadge, RecordNumber } from './BenchmarkBits';
import type { ExtractionResult, QuestionResult, ResultRow } from './useBenchmark';
import { formatScore } from './words';

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-2 border-t px-5 py-4', className)}>
      <h4 className="text-muted-foreground text-xs font-semibold">{title}</h4>
      {children}
    </section>
  );
}

const MESSAGE_STATUS_TEXT: Record<string, string> = {
  answered: 'Answered',
  stopped: 'Stopped before it finished',
  failed: 'Failed',
};

/** The kind a record number belongs to, from its prefix; null for one we don't know. */
function kindOfNumber(number: string): string | null {
  return parseNumber(number)?.kind ?? parseCatalogNumber(number)?.kind ?? parseIntakeNumber(number)?.kind ?? null;
}

function kindText(kind: string): string {
  return Object.hasOwn(RECORD_KIND_TEXT, kind) ? RECORD_KIND_TEXT[kind as keyof typeof RECORD_KIND_TEXT] : kind;
}

/** Why it was skipped, or the code it failed with. */
function ReasonLine({
  outcome,
  reason,
  referenceId,
}: {
  outcome: string;
  reason: string | null;
  referenceId?: string | null;
}) {
  if (!reason && !referenceId) return null;
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      {reason ? (outcome === 'skipped' ? benchmarkSkipReasonText(reason) : `Failed with ${reason}`) : null}
      {reason && referenceId ? '. ' : null}
      {referenceId ? (
        <>
          Reference ID <span className="text-foreground font-semibold select-all">{referenceId}</span>
        </>
      ) : null}
    </p>
  );
}

function Header({ row, children }: { row: ResultRow; children?: ReactNode }) {
  return (
    <header className="grid gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={row.outcome} />
        <span className="text-muted-foreground text-xs font-semibold">{benchmarkKindText(row.kind)}</span>
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
          {row.mode === 'hybrid' || row.mode === 'vector' ? <ModeSwatch mode={row.mode} /> : null}
          {benchmarkPartText(row.part)}, {benchmarkModeText(row.mode)}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">Stored {formatMoment(row.createdAt)}</p>
      {children}
    </header>
  );
}

/** The item's own metric values: its scores and times. */
function Metrics({ row }: { row: ResultRow }) {
  const values = BENCHMARK_ITEM_METRICS.flatMap((name) => {
    const value = row.metrics[name];
    return typeof value === 'number' && Number.isFinite(value) ? [{ name, value }] : [];
  });
  if (values.length === 0) return <p className="text-muted-foreground text-sm">No score: this result wasn’t scored.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
      {values.map(({ name, value }) => {
        const m = BENCHMARK_METRIC_BY_NAME[name];
        return (
          <div key={name} className="flex items-baseline justify-between gap-3 border-b border-dashed pb-1">
            <dt className="text-muted-foreground min-w-0 text-xs">{m.label}</dt>
            <dd className="shrink-0 text-sm font-semibold tabular-nums">
              {m.type === 'time'
                ? formatDuration(value)
                : m.unit === 'flag'
                  ? value >= 1
                    ? 'Yes'
                    : 'No'
                  : formatScore(name, value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function FoundState({ found }: { found: BenchmarkFoundRecord | undefined }) {
  if (!found) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#8f1f15]">
        <CircleX className="size-3.5" aria-hidden />
        Not found
      </span>
    );
  }
  if (found.inContext) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#1f5c38]">
        <CircleCheck className="size-3.5" aria-hidden />
        In the context, rank {found.rank}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#7a5410]">
      <CircleDot className="size-3.5" aria-hidden />
      Found at rank {found.rank}, outside the context
    </span>
  );
}

function Expected({
  expected,
  found,
  kind,
}: {
  expected: readonly BenchmarkExpectedDetail[];
  found: readonly BenchmarkFoundRecord[];
  kind: string;
}) {
  if (expected.length === 0) {
    return (
      <p className="text-sm">
        {kind === 'no_answer'
          ? 'None: the question asks about a made-up name, so the right answer is that there isn’t one.'
          : 'None.'}
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {expected.map((record, i) => {
        const match = record.number ? found.find((f) => f.number === record.number) : undefined;
        return (
          <li key={`${record.number ?? record.name}-${i}`} className="grid gap-0.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              {record.number ? (
                <RecordNumber kind={record.kind} number={record.number} />
              ) : (
                <span className="text-muted-foreground text-xs italic">Not in this org</span>
              )}
              <span className="min-w-0 [overflow-wrap:anywhere]">{record.name}</span>
              <span className="text-muted-foreground text-xs">{kindText(record.kind)}</span>
            </span>
            {record.number ? <FoundState found={match} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function CitationItem({ citation }: { citation: BenchmarkCitation }) {
  const mark = (
    <span className="text-muted-foreground w-6 shrink-0 text-xs font-bold tabular-nums">[{citation.number}]</span>
  );
  if (citation.type === 'hidden') {
    return (
      <li className="flex items-start gap-2 text-sm">
        {mark}
        <span className="text-muted-foreground inline-flex items-center gap-1.5 italic">
          <EyeOff className="size-3.5" aria-hidden />A source the run couldn’t see
        </span>
      </li>
    );
  }
  const matches = (
    <span
      className={cn('shrink-0 text-xs font-semibold', citation.matches ? 'text-[#1f5c38]' : 'text-muted-foreground')}
    >
      {citation.matches ? 'Is or names an expected record' : 'Not an expected record'}
    </span>
  );
  if (citation.type === 'record') {
    return (
      <li className="flex items-start gap-2 text-sm">
        {mark}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <RecordNumber kind={citation.record.kind} number={citation.record.number} />
            <span className="[overflow-wrap:anywhere]">{citation.record.name}</span>
          </span>
          {matches}
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-sm">
      {mark}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-start gap-1.5">
          <BookOpenText className="mt-0.5 size-3.5 shrink-0 text-[#8c7333]" aria-hidden />
          <span className="[overflow-wrap:anywhere]">
            {citation.documentName}
            <span className="text-muted-foreground">, passage {citation.position + 1}</span>
          </span>
        </span>
        {matches}
      </span>
    </li>
  );
}

function GraphPart({ row }: { row: QuestionResult }) {
  const graph = row.details.graph;
  if (row.mode === 'vector') return <p className="text-sm">Not used: vector-only search reads documents only.</p>;
  if (!graph) return <p className="text-muted-foreground text-sm">The search didn’t get as far as the graph.</p>;
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        {graph.ran ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-[#1f5c38]">
            <CircleCheck className="size-4" aria-hidden />
            Ran in the org’s database
          </span>
        ) : graph.fallback ? (
          <span className="inline-flex items-start gap-1.5">
            <CircleX className="mt-0.5 size-4 shrink-0 text-[#8f1f15]" aria-hidden />
            <span>
              <span className="font-semibold">Fell back to documents only.</span> {graphFallbackText(graph.fallback)}
            </span>
          </span>
        ) : (
          'The graph query didn’t run.'
        )}
      </p>
      {graph.query ? (
        <pre className="bg-chrome text-chrome-foreground max-h-56 overflow-auto rounded-md px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
          <code>{graph.query}</code>
        </pre>
      ) : (
        <p className="text-muted-foreground text-xs">No graph query was written.</p>
      )}
    </div>
  );
}

const TIMING_ROWS = [
  ['embeddingMs', 'Embedding the question'],
  ['vectorSearchMs', 'Vector search'],
  ['queryWritingMs', 'Writing the graph query'],
  ['queryRunningMs', 'Running the graph query'],
  ['fusionMs', 'Merging the results'],
  ['waitedMs', 'Waiting for Gemma'],
  ['firstWordsMs', 'First words'],
  ['totalMs', 'Total'],
] as const;

function Timings({ row }: { row: QuestionResult }) {
  const rows = TIMING_ROWS.filter(([key]) => row.details.timings[key] !== null);
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No times were recorded.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
      {rows.map(([key, label]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 border-b border-dashed pb-1">
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className="text-sm font-semibold tabular-nums">{formatDuration(row.details.timings[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function Injection({ row }: { row: QuestionResult }) {
  const injection = row.details.injection;
  if (!injection) return null;
  let result: ReactNode;
  if (injection.followed === true) {
    result = (
      <span className="inline-flex items-center gap-1.5 font-semibold text-[#8f1f15]">
        <ShieldAlert className="size-4" aria-hidden />
        The answer followed the planted instruction
      </span>
    );
  } else if (injection.followed === false) {
    result = (
      <span className="inline-flex items-center gap-1.5 font-semibold text-[#1f5c38]">
        <ShieldCheck className="size-4" aria-hidden />
        The answer didn’t follow the planted instruction
      </span>
    );
  } else {
    result = <span className="text-muted-foreground">Not checked: there was no answer to check.</span>;
  }
  return (
    <Section title="Injection check">
      <p className="text-sm">{result}</p>
      <p className="flex items-start gap-1.5 text-sm">
        <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="[overflow-wrap:anywhere]">
          {benchmarkInjectionKindText(injection.kind)}, planted in {injection.fileName}
        </span>
      </p>
      <p className="text-muted-foreground text-xs leading-relaxed">{injectionCheckText(injection.kind)}</p>
    </Section>
  );
}

function QuestionDetail({ row }: { row: QuestionResult }) {
  const { details } = row;
  return (
    <>
      <Header row={row}>
        <blockquote className="bg-muted/60 rounded-md border px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {details.question}
        </blockquote>
        <ReasonLine outcome={row.outcome} reason={details.reason} referenceId={details.referenceId} />
      </Header>
      <Section title="Scores">
        <Metrics row={row} />
      </Section>
      <Section title="Expected records">
        <Expected expected={details.expected} found={details.found} kind={row.kind} />
        {details.firstMatchRank !== null ? (
          <p className="text-muted-foreground text-xs">
            The first result that is or names an expected record was at rank {details.firstMatchRank}.
          </p>
        ) : null}
      </Section>
      {row.part === 'answers' ? (
        <Section title="Answer">
          {row.details.answer ? (
            <>
              <p className="text-muted-foreground text-xs font-semibold">
                {MESSAGE_STATUS_TEXT[row.details.answer.status] ?? row.details.answer.status}
              </p>
              <div className="max-h-72 overflow-y-auto rounded-md border px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {row.details.answer.text || (
                  <span className="text-muted-foreground italic">No words were written.</span>
                )}
              </div>
              {row.details.answer.citations.length > 0 ? (
                <div className="grid gap-1.5">
                  <h5 className="text-muted-foreground text-xs font-semibold">Citations</h5>
                  <ul className="grid gap-2">
                    {row.details.answer.citations.map((c) => (
                      <CitationItem key={c.number} citation={c} />
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">The answer cited nothing.</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No answer could be read for this question.</p>
          )}
        </Section>
      ) : null}
      <Section title="Graph query">
        <GraphPart row={row} />
      </Section>
      <Section title="Times">
        <Timings row={row} />
      </Section>
      <Injection row={row} />
    </>
  );
}

function End({ end }: { end: { number: string | null; name: string } }) {
  const kind = end.number ? kindOfNumber(end.number) : null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      {end.number ? (
        kind ? (
          <RecordNumber kind={kind} number={end.number} />
        ) : (
          <span className="font-semibold tabular-nums">{end.number}</span>
        )
      ) : null}
      <span className="[overflow-wrap:anywhere]">{end.name}</span>
      {end.number ? null : <span className="text-muted-foreground text-xs italic">(not in this org)</span>}
    </span>
  );
}

/** What an extraction item that no plant made is. */
const NOT_PLANTED_TEXT: Record<string, string> = {
  stated_fact: 'Not a plant: the documents state this link.',
  extra_ai_link: 'Not a plant: a live AI link the answer key doesn’t hold.',
  analyst_decision: 'Not a plant: an Analyst approved or rejected this link.',
};

function ExtractionDetail({ row }: { row: ExtractionResult }) {
  const { details } = row;
  return (
    <>
      <Header row={row}>
        <p className="text-sm leading-relaxed">
          <LinkPhrase from={<End end={details.from} />} type={details.linkType} to={<End end={details.to} />} />
        </p>
        <ReasonLine outcome={row.outcome} reason={details.reason} />
      </Header>
      <Section title="Where it stands">
        <p className="text-sm font-semibold">{extractionLinkStateText(details.state)}</p>
      </Section>
      <Section title="Planted">
        {details.plant ? (
          <p className="flex items-start gap-1.5 text-sm">
            <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="[overflow-wrap:anywhere]">
              {details.plant.type === 'false_positive'
                ? `A planted false positive in ${details.plant.fileName}`
                : `A planted ${benchmarkInjectionKindText(details.plant.injectionKind).toLowerCase()} injection in ${details.plant.fileName}`}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{NOT_PLANTED_TEXT[row.kind] ?? 'Not a plant.'}</p>
        )}
      </Section>
    </>
  );
}

export function ResultDetail({ row }: { row: ResultRow }) {
  return row.part === 'extraction' ? <ExtractionDetail row={row} /> : <QuestionDetail row={row} />;
}
