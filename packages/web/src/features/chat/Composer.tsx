// The question box (S6-007 behaviour 3): up to 2,000 characters; Enter sends and Shift+Enter makes
// a new line; disabled while an answer is being written, with "Stop" in place of "Send". A question
// the API refused before answering goes back into the box, with the refusal above it: "try again in
// N s" for the 10-a-minute limit (counting down), else the app's usual message with its reference ID.
import { rateLimitedText, SEARCH_LIMITS } from '@grc/shared';
import { Clock, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiProblem } from '@/features/records/ApiProblem';
import type { ComposerProblem } from './useChatSession';

const MAX = SEARCH_LIMITS.questionMaxLength;
/** The count shows once the question gets this long. */
const COUNT_FROM = MAX - 300;

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
}: ComposerProps) {
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

  return (
    <form
      className="bg-card grid gap-2 border-t px-4 pt-3 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
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

      <label htmlFor="chat-question" className="sr-only">
        Your question
      </label>
      <Textarea
        id="chat-question"
        ref={textareaRef}
        value={draft}
        maxLength={MAX}
        rows={3}
        disabled={busy}
        placeholder="Ask about your risk data"
        className="max-h-48 min-h-[4.5rem] resize-none text-sm"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center gap-3">
        <p className="text-muted-foreground min-w-0 flex-1 text-[11px] leading-tight">
          Enter to send, Shift+Enter for a new line
          {draft.length >= COUNT_FROM ? (
            <span className={draft.length >= MAX ? 'text-destructive font-semibold' : undefined}>
              {' '}
              ({draft.length.toLocaleString('en-US')} of {MAX.toLocaleString('en-US')} characters)
            </span>
          ) : null}
        </p>
        {answering ? (
          <Button type="button" size="sm" variant="outline" onClick={onStop}>
            <Square className="size-3 fill-current" aria-hidden />
            Stop
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={!canSend}>
            <SendHorizontal aria-hidden />
            Send
          </Button>
        )}
      </div>
    </form>
  );
}
