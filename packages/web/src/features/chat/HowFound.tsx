// "How this answer was found" (S6-007 behaviour 6), collapsed under each answer: the search mode,
// the graph query Gemma wrote (in monospace) or why the graph path fell back, how many records and
// passages the answer used, and the times. All of it is the saved message's own record (D45.8, D69).
import { graphFallbackText, SEARCH_MODE_TEXT } from '@grc/shared';
import { ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { graphQueryOf, type VisibleMessage } from './useChat';
import { counted, formatDuration } from './words';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
      <dd className="min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function usedText(message: VisibleMessage): string {
  let records = 0;
  let passages = 0;
  let hidden = 0;
  for (const c of message.citations) {
    if (c.type === 'record') records += 1;
    else if (c.type === 'passage') passages += 1;
    else hidden += 1;
  }
  const parts = [counted(records, 'record', 'records'), counted(passages, 'passage', 'passages')];
  const used = `${parts[0]} and ${parts[1]}`;
  return hidden > 0
    ? `${used}, plus ${counted(hidden, 'source you can no longer see', 'sources you can no longer see')}`
    : used;
}

function GraphPart({ message }: { message: VisibleMessage }) {
  const query = graphQueryOf(message);
  if (message.mode === 'vector') return <span>Not used: this answer searched documents only.</span>;
  return (
    <div className="grid gap-1.5">
      {message.fallback !== null ? <p>{graphFallbackText(message.fallback)}</p> : null}
      {query !== null ? (
        <pre className="bg-chrome text-chrome-foreground max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
          <code>{query}</code>
        </pre>
      ) : message.fallback === null ? (
        <p>No graph query was written.</p>
      ) : null}
    </div>
  );
}

export function HowFound({ message }: { message: VisibleMessage }) {
  const { timings } = message;
  const details = useRef<HTMLDListElement>(null);
  return (
    <Collapsible
      className="group/how"
      onOpenChange={(open) => {
        // Bring the opened details into view when they open below the panel's edge.
        if (open) requestAnimationFrame(() => details.current?.scrollIntoView({ block: 'nearest' }));
      }}
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/how:rotate-90" aria-hidden />
        How this answer was found
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl ref={details} className="bg-muted/60 mt-2 grid gap-2.5 rounded-md border px-3 py-3">
          <Row label="Search">{SEARCH_MODE_TEXT[message.mode]}</Row>
          <Row label="Graph query">
            <GraphPart message={message} />
          </Row>
          <Row label="Used">{usedText(message)}</Row>
          <Row label="Times">
            <ul className="grid gap-0.5 tabular-nums">
              <li>Waited for its turn: {formatDuration(timings.waitedMs)}</li>
              {timings.searchingMs !== null ? (
                <li>Found the sources in {formatDuration(timings.searchingMs)}</li>
              ) : null}
              {timings.firstWordsMs !== null ? <li>First words after {formatDuration(timings.firstWordsMs)}</li> : null}
              <li>Total {formatDuration(timings.totalMs)}</li>
            </ul>
          </Row>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
