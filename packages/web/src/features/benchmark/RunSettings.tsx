// What a run ran with (S8-010, D45.8): where its questions came from, the question-set format, the
// models, the prompt versions, the search limits and matching cut-offs in effect, the injection
// checks its answers were scored by, and who started it and when. The API fills in the models,
// prompts, limits, cut-offs and checks itself when the run starts (S8-002). A run above the reader's
// clearance shows the hidden words instead of its settings' details (D51).
import { benchmarkInjectionKindText, BENCHMARK_INJECTION_KINDS } from '@grc/shared';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tile } from '@/features/dashboard/Tile';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { HiddenNotice } from './BenchmarkBits';
import type { RunDetail, VisibleRun } from './useBenchmark';
import { dataVersionText, modesText, orgSlugsText, partsText, settingName, settingValue, startedByText } from './words';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
      <dd className="text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="group/set border-t">
      <CollapsibleTrigger className="hover:bg-accent/40 focus-visible:ring-ring flex w-full items-center gap-1.5 px-5 py-3 text-left text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]/set:rotate-90" aria-hidden />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-5 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function NumberList({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <p className="text-muted-foreground text-sm">None recorded.</p>;
  return (
    <dl className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 border-b border-dashed pb-1">
          <dt className="text-muted-foreground text-xs">{settingName(key)}</dt>
          <dd className="text-sm font-semibold tabular-nums">{settingValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Details({ run }: { run: VisibleRun }) {
  const { settings } = run;
  const source = settings.questionSet.source;
  const prompts = Object.entries(settings.promptVersions).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <dl className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Question set">
          {dataVersionText(source)}
          <span className="text-muted-foreground block text-xs">For {orgSlugsText(source.orgSlugs)}</span>
        </Fact>
        {source.type === 'generated' ? <Fact label="Generator">Version {source.generatorVersion}</Fact> : null}
        <Fact label="Question-set format">Version {settings.questionSet.version}</Fact>
        <Fact label="Measured">
          {partsText(settings.parts)}
          <span className="text-muted-foreground block text-xs">
            {modesText(settings.modes)}, {settings.questionCount}{' '}
            {settings.questionCount === 1 ? 'question' : 'questions'}
          </span>
        </Fact>
        <Fact label="Text model">{settings.models.text}</Fact>
        <Fact label="Embedding model">{settings.models.embedding}</Fact>
        <Fact label="Prompt versions">
          {prompts.length === 0 ? (
            '—'
          ) : (
            <span className="grid gap-0.5">
              {prompts.map(([step, version]) => (
                <span key={step}>
                  <span className="text-muted-foreground">{settingName(step)}:</span> {version}
                </span>
              ))}
            </span>
          )}
        </Fact>
        <Fact label="Started">
          {formatMoment(run.startedAt)}
          <span className="text-muted-foreground block text-xs">by {startedByText(run.startedBy)}</span>
        </Fact>
        <Fact label={run.status === 'failed' ? 'Failed' : 'Finished'}>
          {run.finishedAt ? formatMoment(run.finishedAt) : 'Still running'}
        </Fact>
        <Fact label="Label">
          <LabelBadge label={run.label} />
          <span className="text-muted-foreground block pt-1 text-xs">The clearance of whoever started it</span>
        </Fact>
      </dl>
      <Disclosure title="Search limits in effect">
        <NumberList values={settings.limits} />
      </Disclosure>
      <Disclosure title="Duplicate-matching cut-offs in effect">
        <NumberList values={settings.cutOffs} />
      </Disclosure>
      <Disclosure title="Injection checks the answers were scored by">
        <dl className="grid gap-3">
          {BENCHMARK_INJECTION_KINDS.map((kind) => (
            <div key={kind} className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-semibold">{benchmarkInjectionKindText(kind)}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{settings.injectionChecks[kind]}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </>
  );
}

export function RunSettings({ run }: { run: RunDetail }) {
  return (
    <Tile id="run-settings" title="What this run ran with" bodyClassName="p-0">
      {run.hidden ? (
        <div className="px-5 py-4">
          <HiddenNotice />
        </div>
      ) : (
        <Details run={run} />
      )}
    </Tile>
  );
}
