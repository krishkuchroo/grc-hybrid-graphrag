// The open conversation as the quick panel (./ChatPanel) and the Ask page (./AskPage) both show it
// (D262): its saved messages, then this session's questions it doesn't hold yet, with "Try again" on
// the latest question only. A conversation that can't be opened (someone else's, removed, or a
// malformed ID: the API decides, D7) shows the problem with "New conversation". Each view gives its
// own empty state (the panel's short note, the page's welcome) and its size: 'panel' renders as the
// panel always has, 'page' in a centred column of about 48rem with larger type.
// - announcementOf: what the one polite live region of the view says, each step and outcome once,
//   never the answer's words.
// - useKeepAtBottom: keeps the newest words in view while the person is at the bottom.
import { CHAT_TEXT, chatStepText, queuePositionText } from '@grc/shared';
import { SquarePen } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { LiveTurnView, MessageView, type ChatSize, type RetryProps } from './Messages';
import { turnsShown, type ChatSession, type LiveTurn } from './useChatSession';

/** What the live region says: each step and outcome once, never the answer's words. */
export function announcementOf(turn: LiveTurn | null): string {
  if (turn === null) return '';
  switch (turn.phase) {
    case 'sending':
      return 'Sending your question';
    case 'queued':
      return queuePositionText(turn.position ?? 1);
    case 'working':
    case 'answering': {
      const step = turn.steps[turn.steps.length - 1];
      return step === undefined ? '' : chatStepText(step);
    }
    case 'answered':
      return 'The answer is ready';
    case 'stopped':
      return CHAT_TEXT.stopped;
    case 'failed':
      return turn.failure === null || turn.failure.code === 'assistant_unavailable'
        ? CHAT_TEXT.unavailable
        : turn.failure.message;
  }
}

/** The page's thread column: centred, about 48rem wide, the same side padding as its question box. */
const PAGE_COLUMN = 'mx-auto w-full max-w-[48rem] px-4 sm:px-6';

export function ThreadSkeleton({ size = 'panel' }: { size?: ChatSize }) {
  if (size === 'page') {
    return (
      <div aria-label="Loading the conversation" className={`${PAGE_COLUMN} grid gap-9 py-8`}>
        {[0, 1].map((i) => (
          <div key={i} className="grid gap-3.5">
            <span className="bg-muted h-11 w-1/2 animate-pulse justify-self-end rounded-2xl" />
            <span className="bg-muted h-4 w-28 animate-pulse rounded-sm" />
            <span className="bg-muted ml-[2.375rem] h-24 animate-pulse rounded-md" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-label="Loading the conversation" className="grid gap-6 px-4 py-5">
      {[0, 1].map((i) => (
        <div key={i} className="grid gap-3">
          <span className="bg-muted h-9 w-2/3 animate-pulse justify-self-end rounded-lg" />
          <span className="bg-muted h-3.5 w-24 animate-pulse rounded-sm" />
          <span className="bg-muted ml-8 h-16 animate-pulse rounded-md" />
        </div>
      ))}
    </div>
  );
}

export function Thread({
  session,
  role,
  onNew,
  empty,
  size = 'panel',
}: {
  session: ChatSession;
  role: string | undefined;
  /** "New conversation" under a conversation that couldn't be opened. */
  onNew: () => void;
  /** What an empty conversation shows. */
  empty: ReactNode;
  size?: ChatSize;
}) {
  const { conversationId, conversation } = session;
  const messages = conversation.data?.messages ?? [];
  const shown = turnsShown(session.turns, conversationId, conversation.data?.messages);
  const onRetry = (question: string) => void session.ask(question);
  const page = size === 'page';

  if (conversationId !== null && conversation.isError) {
    return (
      <div className={page ? `${PAGE_COLUMN} py-8` : 'px-4 py-5'}>
        <ApiProblem error={conversation.error} title="This conversation couldn't be opened">
          <Button type="button" size="sm" variant="outline" onClick={onNew}>
            <SquarePen aria-hidden />
            New conversation
          </Button>
        </ApiProblem>
      </div>
    );
  }
  if (conversationId !== null && conversation.isPending && shown.length === 0) return <ThreadSkeleton size={size} />;
  if (messages.length === 0 && shown.length === 0) return <>{empty}</>;

  // "Try again" goes with the conversation's latest question only.
  const lastRetry: RetryProps = { canRetry: !session.busy, onRetry };
  const noRetry: RetryProps = { canRetry: false, onRetry };
  return (
    <div className={page ? `${PAGE_COLUMN} grid gap-10 py-8` : 'grid gap-7 px-4 py-5'}>
      {messages.map((message, i) => (
        <MessageView
          key={message.id}
          message={message}
          failure={session.failures[message.id]}
          retry={shown.length === 0 && i === messages.length - 1 ? lastRetry : noRetry}
          role={role}
          size={size}
        />
      ))}
      {shown.map((turn, i) => (
        <LiveTurnView
          key={turn.key}
          turn={turn}
          retry={i === shown.length - 1 ? lastRetry : noRetry}
          role={role}
          size={size}
        />
      ))}
    </div>
  );
}

/**
 * Keeps the newest words in view while the person is at the bottom; a new question or another
 * conversation always starts there. `shownAgain` changes when the view puts the thread back in place
 * (the panel's list view, the page's folded column), so it is scrolled again then.
 */
export function useKeepAtBottom(session: ChatSession, shownAgain: unknown) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { conversationId, latest } = session;
  const messageCount = session.conversation.data?.messages.length ?? 0;
  const lastKey = useRef<number | undefined>(undefined);
  const lastConversation = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    if (latest?.key !== lastKey.current || conversationId !== lastConversation.current) stick.current = true;
    lastKey.current = latest?.key;
    lastConversation.current = conversationId;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [
    shownAgain,
    conversationId,
    messageCount,
    latest?.key,
    latest?.phase,
    latest?.answer,
    latest?.steps.length,
    latest?.saved,
  ]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (el !== null) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  return { scrollerRef, onScroll };
}
