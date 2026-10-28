// The question box (S6-007 behaviour 3): up to 2,000 characters; Enter sends and Shift+Enter makes
// a new line; disabled while an answer is being written, with "Stop" in place of "Send". A question
// the API refused before answering goes back into the box, with the refusal above it: "try again in
// N s" for the 10-a-minute limit (counting down), else the app's usual message with its reference ID.
// Two sizes (D262): 'panel', the quick panel's box, and 'page', the Ask page's: one raised card with
// larger text that grows with the question before it scrolls. The box's id is the component's own
// (useId), so the panel's and the page's can't clash.
import { rateLimitedText, SEARCH_LIMITS } from '@grc/shared';
import { Clock, SendHorizontal, Square } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiProblem } from '@/features/records/ApiProblem';
import type { ChatSize } from './Messages';
import type { ComposerProblem } from './useChatSession';

const MAX = SEARCH_LIMITS.questionMaxLength;
/** The count shows once the question gets this long. */
const COUNT_FROM = MAX - 300;
/** How tall the page's box grows before it scrolls, in pixels (16rem). */
const PAGE_BOX_MAX_PX = 256;

function useSecondsLeft(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

export interface ComposerProps {
  draft: string;
  onDraftChange: (text: string) => void;
  onAsk: (question: string) => void;
  onStop: () => void;
  /** An answer is being written in this conversation. */
  answering: boolean;
  /** An answer is being written in another conversation. */
  answeringElsewhere: boolean;
  /** The box waits: a conversation is being started or an answer written. */
  busy: boolean;
  problem: ComposerProblem | null;
  onClearProblem: () => void;
  textareaRef: Ref<HTMLTextAreaElement>;
  /** The quick panel's box (the default) or the Ask page's larger one. */
  size?: ChatSize;
}

export function Composer({
  draft,
  onDraftChange,
  onAsk,
  onStop,
  answering,
  answeringElsewhere,
  busy,
  problem,
  onClearProblem,
  textareaRef,
  size = 'panel',
}: ComposerProps) {
  const page = size === 'page';
  const boxId = useId();
  const box = useRef<HTMLTextAreaElement | null>(null);
  const setBox = useCallback(
    (el: HTMLTextAreaElement | null) => {
      box.current = el;
      if (typeof textareaRef === 'function') textareaRef(el);
      else if (textareaRef !== null && textareaRef !== undefined) textareaRef.current = el;
    },
    [textareaRef],
  );

  // The page's box grows with the question, from its three rows up to its limit, then scrolls. A
  // box that isn't shown (the page's list in its place) keeps its height until it is.
  useLayoutEffect(() => {
    const el = box.current;
    if (!page || el === null || el.offsetParent === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, PAGE_BOX_MAX_PX)}px`;
  }, [page, draft]);

  const until = problem?.kind === 'rate_limited' ? problem.until : null;
  const secondsLeft = useSecondsLeft(until);
  const waiting = until !== null && secondsLeft > 0;

  useEffect(() => {
    if (until !== null && secondsLeft === 0) onClearProblem();
  }, [until, secondsLeft, onClearProblem]);

  const canSend = !busy && !waiting && draft.trim() !== '' && draft.length <= MAX;
  const send = () => {
    if (canSend) onAsk(draft);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const notices = (
    <>
      {waiting ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-[#e3c98f] bg-[#fdf6e5] px-3 py-2 text-[13px] text-[#6b4a0e]"
        >
          <Clock className="size-4 shrink-0" aria-hidden />
          {rateLimitedText(secondsLeft)}
        </p>
      ) : null}
      {problem?.kind === 'refused' ? <ApiProblem error={problem.error} title="Your question wasn't sent" /> : null}
      {answeringElsewhere ? (
        <p className="text-muted-foreground text-xs">An answer is being written in another conversation.</p>
      ) : null}
    </>
  );

  const label = (
    <label htmlFor={boxId} className="sr-only">
      Your question
    </label>
  );

  const textarea = (className: string) => (
    <Textarea
      id={boxId}
      ref={setBox}
      value={draft}
      maxLength={MAX}
      rows={3}
      disabled={busy}
      placeholder="Ask about your risk data"
      className={className}
      onChange={(event) => onDraftChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          send();
        }
      }}
    />
  );

  const hint = (className: string) => (
    <p className={className}>
      Enter to send, Shift+Enter for a new line
      {draft.length >= COUNT_FROM ? (
        <span className={draft.length >= MAX ? 'text-destructive font-semibold' : undefined}>
          {' '}
          ({draft.length.toLocaleString('en-US')} of {MAX.toLocaleString('en-US')} characters)
        </span>
      ) : null}
    </p>
  );

  const action = (buttonSize: 'sm' | 'default') =>
    answering ? (
      <Button type="button" size={buttonSize} variant="outline" onClick={onStop}>
        <Square className="size-3 fill-current" aria-hidden />
        Stop
      </Button>
    ) : (
      <Button type="submit" size={buttonSize} disabled={!canSend}>
        <SendHorizontal aria-hidden />
        Send
      </Button>
    );

  if (page) {
    return (
      <form className="grid gap-2.5" onSubmit={onSubmit}>
        {notices}
        <div className="bg-card focus-within:border-ring focus-within:ring-ring/40 rounded-xl border shadow-[0_1px_2px_rgba(21,38,47,0.06),0_12px_32px_-16px_rgba(21,38,47,0.28)] transition-[border-color,box-shadow] focus-within:ring-[3px]">
          {label}
          {textarea(
            'min-h-[6rem] resize-none rounded-xl border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[15px]',
          )}
          <div className="flex items-center gap-3 pr-3 pb-3 pl-4">
            {hint('text-muted-foreground min-w-0 flex-1 text-xs leading-tight')}
            {action('default')}
          </div>
        </div>
      </form>
    );
  }

  return (
    <form className="bg-card grid gap-2 border-t px-4 pt-3 pb-4" onSubmit={onSubmit}>
      {notices}
      {label}
      {textarea('max-h-48 min-h-[4.5rem] resize-none text-sm')}
      <div className="flex items-center gap-3">
        {hint('text-muted-foreground min-w-0 flex-1 text-[11px] leading-tight')}
        {action('sm')}
      </div>
    </form>
  );
}
