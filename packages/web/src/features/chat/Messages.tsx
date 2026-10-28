// One question and its answer in the chat panel (S6-007 behaviours 4–7), for a saved message and
// for the question being answered now.
// - The question sits on the right; the answer on the left, under the assistant's mark.
// - While waiting: the place in the queue ("You're number N in the queue"), then the steps.
// - The answer streams in as written; once it is done, its source numbers become chips, with the
//   Sources list and "How this answer was found" under it.
// - S6-001's plain words for documents only (a notice above the answer), nothing found,
//   unavailable (with "Try again"), stopped and hidden. Any other failure shows the app's usual
//   message with its reference ID.
// - Under a saved answer (live once `done` has come, or reopened), the "Not reviewed yet" part
//   (D260, ./PendingLinks) when the API listed pending link findings with it.
// - Two sizes (D262): 'panel', the quick panel's, and 'page', the Ask page's larger type. MessageView
//   and LiveTurnView take it as a prop and pass it to their parts through a context.
import { CHAT_STEPS, CHAT_TEXT, chatStepText, queuePositionText, type AnswerSource, type ChatStep } from '@grc/shared';
import {
  Check,
  CircleAlert,
  Circle,
  Hourglass,
  Info,
  LoaderCircle,
  Lock,
  RotateCcw,
  SearchX,
  Sparkles,
  Square,
} from 'lucide-react';
import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { cn } from '@/lib/utils';
import { answerBlocks, citedNumbersInOrder, type Inline } from './answerText';
import { CitationChip, SourcesList } from './Citations';
import { HowFound } from './HowFound';
import { PendingLinks } from './PendingLinks';
import type { Message, MessageCitation, VisibleMessage } from './useChat';
import type { LiveTurn, TurnFailure } from './useChatSession';
import { counted, messageTime } from './words';

/** Where a conversation is shown: the quick panel, or the Ask page with larger type. */
export type ChatSize = 'panel' | 'page';

const SizeContext = createContext<ChatSize>('panel');

function useSize(): ChatSize {
  return useContext(SizeContext);
}

export interface RetryProps {
  /** Offered on the latest question only, when nothing else is being answered. */
  canRetry: boolean;
  onRetry: (question: string) => void;
}

function QuestionBubble({ text, at }: { text: string; at: string }) {
  const page = useSize() === 'page';
  return (
    <div className={page ? 'grid justify-items-end gap-1.5' : 'grid justify-items-end gap-1'}>
      <p
        className={
          page
            ? 'bg-accent text-accent-foreground max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]'
            : 'bg-accent text-accent-foreground max-w-[88%] rounded-lg rounded-br-sm px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]'
        }
      >
        {text}
      </p>
      <time dateTime={at} className={cn('text-muted-foreground tabular-nums', page ? 'text-xs' : 'text-[11px]')}>
        {messageTime(at)}
      </time>
    </div>
  );
}

function AssistantMark() {
  const page = useSize() === 'page';
  return (
    <div className={page ? 'flex items-center gap-2.5' : 'flex items-center gap-2'}>
      <span
        aria-hidden
        className={cn('bg-chrome text-brand grid shrink-0 place-items-center rounded-full', page ? 'size-7' : 'size-6')}
      >
        <Sparkles className={page ? 'size-4' : 'size-3.5'} />
      </span>
      <span className={page ? 'text-[13px] font-semibold' : 'text-xs font-semibold'}>Assistant</span>
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'info' | 'amber' | 'grey';
  icon: typeof Info;
  children: ReactNode;
}) {
  const page = useSize() === 'page';
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 leading-snug',
        page ? 'text-sm' : 'text-[13px]',
        tone === 'info' && 'border-[#9cc4d0] bg-[#eaf4f7] text-[#12404d]',
        tone === 'amber' && 'border-[#e3c98f] bg-[#fdf6e5] text-[#6b4a0e]',
        tone === 'grey' && 'bg-muted text-muted-foreground border-border',
      )}
    >
      <Icon className="mt-px size-4 shrink-0" aria-hidden />
      <div className="grid min-w-0 gap-2">{children}</div>
    </div>
  );
}

function StoppedTag() {
  return (
    <span className="border-border bg-muted text-muted-foreground inline-flex items-center gap-1.5 justify-self-start rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold">
      <Square className="size-2.5 fill-current" aria-hidden />
      {CHAT_TEXT.stopped}
    </span>
  );
}

function RetryButton({ question, retry }: { question: string; retry: RetryProps }) {
  if (!retry.canRetry) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="justify-self-start"
      onClick={() => retry.onRetry(question)}
    >
      <RotateCcw aria-hidden />
      Try again
    </Button>
  );
}

/** A question that couldn't be answered: the assistant was unavailable, or something else failed. */
function FailureNotice({
  failure,
  question,
  retry,
}: {
  failure: TurnFailure | undefined;
  question: string;
  retry: RetryProps;
}) {
  if (failure === undefined || failure.code === 'assistant_unavailable') {
    return (
      <Notice tone="amber" icon={CircleAlert}>
        <p>{CHAT_TEXT.unavailable}</p>
        <RetryButton question={question} retry={retry} />
      </Notice>
    );
  }
  if (failure.code === 'connection_lost') {
    return (
      <Notice tone="amber" icon={CircleAlert}>
        <p>{failure.message}</p>
        <RetryButton question={question} retry={retry} />
      </Notice>
    );
  }
  return (
    <ApiProblem
      title="This question couldn't be answered"
      error={new ApiError(0, failure.code, failure.message, failure.referenceId)}
    >
      <RetryButton question={question} retry={retry} />
    </ApiProblem>
  );
}

function Caret() {
  return (
    <span aria-hidden className="bg-primary ml-0.5 inline-block h-[1.05em] w-[2px] animate-pulse align-[-0.15em]" />
  );
}

/** The answer's words: paragraphs and lists, with the citations as chips once it is done. */
export function AnswerBody({
  text,
  citations,
  streaming = false,
  role,
}: {
  text: string;
  /** The message's citations; null while it is being written. */
  citations: MessageCitation[] | null;
  streaming?: boolean;
  role: string | undefined;
}) {
  const page = useSize() === 'page';
  const blocks = answerBlocks(text);
  const byNumber = new Map((citations ?? []).map((c) => [c.number, c]));

  const pieces = (line: Inline[], caret: boolean) => (
    <>
      {line.map((piece, i) => {
        if (piece.type === 'text') return <Fragment key={i}>{piece.text}</Fragment>;
        if (piece.type === 'strong') {
          return (
            <strong key={i} className="font-semibold">
              {piece.text}
            </strong>
          );
        }
        const cited =
          citations === null
            ? []
            : piece.numbers.map((n) => byNumber.get(n)).filter((c): c is MessageCitation => c !== undefined);
        if (cited.length === 0) {
          return (
            <span key={i} className="text-muted-foreground">
              {piece.raw}
            </span>
          );
        }
        return (
          <Fragment key={i}>
            {cited.map((c) => (
              <CitationChip key={c.number} citation={c} role={role} />
            ))}
          </Fragment>
        );
      })}
      {caret ? <Caret /> : null}
    </>
  );

  if (blocks.length === 0) return streaming ? <Caret /> : null;
  return (
    <div
      className={
        page
          ? 'grid gap-3 text-[15px] leading-[1.7] [overflow-wrap:anywhere]'
          : 'grid gap-2 text-sm leading-relaxed [overflow-wrap:anywhere]'
      }
    >
      {blocks.map((block, b) => {
        const lastBlock = streaming && b === blocks.length - 1;
        if (block.type === 'paragraph') {
          return (
            <p key={b}>
              {block.lines.map((line, l) => (
                <Fragment key={l}>
                  {l > 0 ? <br /> : null}
                  {pieces(line, lastBlock && l === block.lines.length - 1)}
                </Fragment>
              ))}
            </p>
          );
        }
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List
            key={b}
            className={cn(
              'grid gap-1 pl-5',
              block.ordered ? 'list-decimal' : 'list-disc',
              'marker:text-muted-foreground',
            )}
          >
            {block.items.map((item, i) => (
              <li key={i} className="pl-0.5">
                {pieces(item, lastBlock && i === block.items.length - 1)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** "Nothing found": the plain words, said without asking Gemma (S6-Q6). */
function isNothingFound(message: VisibleMessage): boolean {
  return (
    message.status === 'answered' && message.citations.length === 0 && message.answer.trim() === CHAT_TEXT.nothingFound
  );
}

function SavedAnswer({
  message,
  failure,
  retry,
  role,
}: {
  message: VisibleMessage;
  failure: TurnFailure | undefined;
  retry: RetryProps;
  role: string | undefined;
}) {
  if (message.status === 'failed') {
    return (
      <>
        <FailureNotice failure={failure} question={message.question} retry={retry} />
        <PendingLinks pendingLinks={message.pendingLinks} />
      </>
    );
  }
  return (
    <>
      {message.fallback !== null ? (
        <Notice tone="info" icon={Info}>
          <p>{CHAT_TEXT.documentsOnly}</p>
        </Notice>
      ) : null}
      {isNothingFound(message) ? (
        <Notice tone="grey" icon={SearchX}>
          <p>{CHAT_TEXT.nothingFound}</p>
        </Notice>
      ) : (
        <AnswerBody text={message.answer} citations={message.citations} role={role} />
      )}
      {message.status === 'stopped' ? <StoppedTag /> : null}
      {message.status === 'stopped' && failure?.code === 'connection_lost' ? (
        <p className="text-muted-foreground text-xs">{failure.message}</p>
      ) : null}
      <SourcesList citations={message.citations} role={role} />
      <HowFound message={message} />
      <PendingLinks pendingLinks={message.pendingLinks} />
    </>
  );
}

function HiddenAnswer() {
  return (
    <Notice tone="grey" icon={Lock}>
      <p>{CHAT_TEXT.hidden}</p>
    </Notice>
  );
}

function AnswerFrame({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  const page = useSize() === 'page';
  return (
    <div className={page ? 'grid gap-3' : 'grid gap-2.5'} aria-busy={busy || undefined}>
      <AssistantMark />
      <div className={page ? 'grid gap-3.5 pl-[2.375rem]' : 'grid gap-3 pl-8'}>{children}</div>
    </div>
  );
}

/** A saved question and its answer. */
export function MessageView({
  message,
  failure,
  retry,
  role,
  size = 'panel',
}: {
  message: Message;
  failure: TurnFailure | undefined;
  retry: RetryProps;
  role: string | undefined;
  size?: ChatSize;
}) {
  return (
    <SizeContext.Provider value={size}>
      <article aria-label="Question and answer" className={size === 'page' ? 'grid gap-4' : 'grid gap-3'}>
        <QuestionBubble text={message.question} at={message.createdAt} />
        <AnswerFrame>
          {message.hidden ? (
            <HiddenAnswer />
          ) : (
            <SavedAnswer message={message} failure={failure} retry={retry} role={role} />
          )}
        </AnswerFrame>
      </article>
    </SizeContext.Provider>
  );
}

/** The panel always searches documents and the graph (S6-Q3), so it shows all three steps. */
const SHOWN_STEPS: readonly ChatStep[] = CHAT_STEPS;

function Progress({ turn }: { turn: LiveTurn }) {
  const page = useSize() === 'page';
  if (turn.phase === 'sending') {
    return (
      <p className={cn('text-muted-foreground flex items-center gap-2', page ? 'text-sm' : 'text-[13px]')}>
        <LoaderCircle className="text-primary size-4 animate-spin" aria-hidden />
        Sending your question
      </p>
    );
  }
  if (turn.phase === 'queued') {
    return (
      <div className="flex items-start gap-2.5 rounded-md border border-[#c9dadd] bg-[#f3f8f8] px-3 py-2.5">
        <Hourglass className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="grid gap-0.5">
          <p className={page ? 'text-sm font-semibold' : 'text-[13px] font-semibold'}>
            {queuePositionText(turn.position ?? 1)}
          </p>
          <p className="text-muted-foreground text-xs">Questions are answered one at a time.</p>
        </div>
      </div>
    );
  }
  const current = turn.steps[turn.steps.length - 1];
  return (
    <ol aria-label="Progress" className="grid gap-1.5 border-l-2 border-[#c9dadd] py-0.5 pl-3">
      {SHOWN_STEPS.map((step) => {
        const reached = turn.steps.includes(step);
        const active = reached && step === current;
        return (
          <li
            key={step}
            className={cn(
              'flex items-center gap-2',
              page ? 'text-sm' : 'text-[13px]',
              active ? 'text-foreground font-semibold' : reached ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {active ? (
              <LoaderCircle className="text-primary size-3.5 animate-spin" aria-hidden />
            ) : reached ? (
              <Check className="size-3.5 text-[#2f8a55]" aria-hidden />
            ) : (
              <Circle className="size-3.5 opacity-50" aria-hidden />
            )}
            {chatStepText(step)}
            {step === 'querying_graph' && turn.sources !== null ? (
              <span className="text-muted-foreground text-xs font-normal">
                {counted(turn.sources.length, 'source found', 'sources found')}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The citations of an answer that ended without its saved message: the sources it names. */
function localCitations(answer: string, sources: AnswerSource[] | null): MessageCitation[] {
  if (sources === null) return [];
  const byNumber = new Map(sources.map((s) => [s.number, s]));
  return citedNumbersInOrder(answer)
    .map((n) => byNumber.get(n))
    .filter((s): s is AnswerSource => s !== undefined)
    .sort((a, b) => a.number - b.number);
}

/** The question being answered now, as its events have told it so far. */
export function LiveTurnView({
  turn,
  retry,
  role,
  size = 'panel',
}: {
  turn: LiveTurn;
  retry: RetryProps;
  role: string | undefined;
  size?: ChatSize;
}) {
  if (turn.saved !== null) {
    return (
      <MessageView message={turn.saved} failure={turn.failure ?? undefined} retry={retry} role={role} size={size} />
    );
  }
  const writing =
    turn.phase === 'sending' || turn.phase === 'queued' || turn.phase === 'working' || turn.phase === 'answering';
  const nothingFound = turn.sources !== null && turn.sources.length === 0;
  return (
    <SizeContext.Provider value={size}>
      <article aria-label="Question and answer" className={size === 'page' ? 'grid gap-4' : 'grid gap-3'}>
        <QuestionBubble text={turn.question} at={turn.askedAt} />
        <AnswerFrame busy={writing}>
          {writing && !(turn.phase === 'answering' && nothingFound) ? <Progress turn={turn} /> : null}
          {turn.fallback !== null && turn.phase !== 'failed' ? (
            <Notice tone="info" icon={Info}>
              <p>{CHAT_TEXT.documentsOnly}</p>
            </Notice>
          ) : null}
          {turn.phase === 'failed' ? (
            <>
              {turn.answer !== '' && turn.failure?.code === 'connection_lost' ? (
                <AnswerBody text={turn.answer} citations={localCitations(turn.answer, turn.sources)} role={role} />
              ) : null}
              <FailureNotice failure={turn.failure ?? undefined} question={turn.question} retry={retry} />
            </>
          ) : nothingFound && turn.answer.trim() === CHAT_TEXT.nothingFound ? (
            <Notice tone="grey" icon={SearchX}>
              <p>{CHAT_TEXT.nothingFound}</p>
            </Notice>
          ) : turn.phase === 'stopped' || turn.phase === 'answered' ? (
            <AnswerBody text={turn.answer} citations={localCitations(turn.answer, turn.sources)} role={role} />
          ) : turn.answer !== '' ? (
            <AnswerBody text={turn.answer} citations={null} streaming role={role} />
          ) : null}
          {turn.phase === 'stopped' ? <StoppedTag /> : null}
          {turn.phase === 'stopped' || turn.phase === 'answered' ? (
            <SourcesList citations={localCitations(turn.answer, turn.sources)} role={role} />
          ) : null}
        </AnswerFrame>
      </article>
    </SizeContext.Provider>
  );
}
