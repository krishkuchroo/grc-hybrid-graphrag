// Screen 9, the chat side panel (S6-007, D27 #9), after ServiceNow's assistant panel (D2). "Ask" in
// the header, for every signed-in person (the Chat cell is every role's, D50), opens it on the
// right, over whatever screen is showing. It isn't modal: the screen behind it stays usable, it
// stays open while the person moves between screens (a record chip opens the record's page beside
// it), and it closes with its close button or Esc. Opening puts the keyboard in the question box;
// closing gives it back to "Ask".
// - Conversations are the person's own (./ConversationList); a new one is started by its first
//   question, so no empty conversation is left behind.
// - The panel always searches both documents and the graph (S6-Q3).
// - Steps and outcomes are read out to screen readers once each (a polite live region); the answer's
//   words are not, as they arrive.
// The API decides what anyone may see or ask (D7): this panel only shows its answers.
import { CHAT_TEXT, chatStepText, queuePositionText } from '@grc/shared';
import { ArrowLeft, History, Sparkles, SquarePen, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiProblem } from '@/features/records/ApiProblem';
import { useMe } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { LiveTurnView, MessageView, type RetryProps } from './Messages';
import { turnsShown, useChatSession, type ChatSession, type LiveTurn } from './useChatSession';
import { EMPTY_TEXT } from './words';

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & ComponentProps<'button'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground size-8"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** What the live region says: each step and outcome once, never the answer's words. */
function announcementOf(turn: LiveTurn | null): string {
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

function EmptyThread() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-10 py-12 text-center">
      <span aria-hidden className="bg-chrome text-brand grid size-12 place-items-center rounded-full shadow-sm">
        <Sparkles className="size-5" />
      </span>
      <div className="grid gap-1.5">
        <h3 className="text-[15px] font-semibold">Ask about your risk data</h3>
        <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">{EMPTY_TEXT}</p>
      </div>
    </div>
  );
}

function ThreadSkeleton() {
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

function Thread({ session, role, onNew }: { session: ChatSession; role: string | undefined; onNew: () => void }) {
  const { conversationId, conversation } = session;
  const messages = conversation.data?.messages ?? [];
  const shown = turnsShown(session.turns, conversationId, conversation.data?.messages);
  const onRetry = (question: string) => void session.ask(question);

  if (conversationId !== null && conversation.isError) {
    return (
      <div className="px-4 py-5">
        <ApiProblem error={conversation.error} title="This conversation couldn't be opened">
          <Button type="button" size="sm" variant="outline" onClick={onNew}>
            <SquarePen aria-hidden />
            New conversation
          </Button>
        </ApiProblem>
      </div>
    );
  }
  if (conversationId !== null && conversation.isPending && shown.length === 0) return <ThreadSkeleton />;
  if (messages.length === 0 && shown.length === 0) return <EmptyThread />;

  // "Try again" goes with the conversation's latest question only.
  const lastRetry: RetryProps = { canRetry: !session.busy, onRetry };
  const noRetry: RetryProps = { canRetry: false, onRetry };
  return (
    <div className="grid gap-7 px-4 py-5">
      {messages.map((message, i) => (
        <MessageView
          key={message.id}
          message={message}
          failure={session.failures[message.id]}
          retry={shown.length === 0 && i === messages.length - 1 ? lastRetry : noRetry}
          role={role}
        />
      ))}
      {shown.map((turn, i) => (
        <LiveTurnView key={turn.key} turn={turn} retry={i === shown.length - 1 ? lastRetry : noRetry} role={role} />
      ))}
    </div>
  );
}

function PanelContent({ session, role }: { session: ChatSession; role: string | undefined }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { view, conversationId, busy } = session;
  const latest = session.latest;
  const title = conversationId === null ? CHAT_TEXT.newConversation : (session.conversation.data?.title ?? '');

  const focusBox = () => {
    const box = textareaRef.current;
    if (box !== null && !box.disabled) box.focus();
    else contentRef.current?.focus();
  };

  // Moving between the list and a conversation moves the keyboard with it.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (view === 'thread') focusBox();
    else newButtonRef.current?.focus();
  }, [view]);

  // When an answer ends, the box is usable again: give it the keyboard back if it was lost.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && view === 'thread') {
      const active = document.activeElement;
      if (active === null || active === document.body || contentRef.current?.contains(active)) focusBox();
    }
    wasBusy.current = busy;
  }, [busy, view]);

  // Keep the newest words in view while the person is at the bottom; a new question or another
  // conversation always starts there.
  const messageCount = session.conversation.data?.messages.length ?? 0;
  const lastKey = useRef<number | undefined>(undefined);
  const lastConversation = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    if (latest?.key !== lastKey.current || conversationId !== lastConversation.current) stick.current = true;
    lastKey.current = latest?.key;
    lastConversation.current = conversationId;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [
    view,
    conversationId,
    messageCount,
    latest?.key,
    latest?.phase,
    latest?.answer,
    latest?.steps.length,
    latest?.saved,
  ]);

  const onScroll = () => {
    const el = scroller.current;
    if (el !== null) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const startNew = () => {
    session.newConversation();
    if (view === 'thread') focusBox();
  };

  const answeringHere = session.answering !== null && session.answering.conversationId === conversationId;
  const answeringElsewhere = session.answering !== null && !answeringHere;

  return (
    <DialogPrimitive.Content
      ref={contentRef}
      aria-describedby={undefined}
      onInteractOutside={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (view === 'thread') focusBox();
        else newButtonRef.current?.focus();
      }}
      className="animate-panel-in bg-background fixed top-14 right-0 bottom-0 z-40 flex w-full flex-col border-l shadow-[-16px_0_40px_-16px_rgba(21,38,47,0.35)] outline-none sm:w-[28rem]"
    >
      <TooltipProvider>
        <div className="bg-card flex h-14 shrink-0 items-center gap-2.5 border-b px-3">
          {view === 'list' ? (
            <IconButton label="Back to the conversation" onClick={() => session.setView('thread')}>
              <ArrowLeft aria-hidden />
            </IconButton>
          ) : (
            <span aria-hidden className="bg-chrome text-brand grid size-8 shrink-0 place-items-center rounded-full">
              <Sparkles className="size-4" />
            </span>
          )}
          <div className="grid min-w-0 flex-1 leading-tight">
            <DialogPrimitive.Title className="text-sm font-semibold">
              {view === 'list' ? 'Conversations' : 'Ask'}
            </DialogPrimitive.Title>
            {view === 'thread' ? <p className="text-muted-foreground truncate text-xs">{title}</p> : null}
          </div>
          {view === 'thread' ? (
            <>
              <IconButton label="Conversations" onClick={() => session.setView('list')}>
                <History aria-hidden />
              </IconButton>
              <IconButton label="New conversation" onClick={startNew}>
                <SquarePen aria-hidden />
              </IconButton>
            </>
          ) : null}
          <IconButton label="Close" onClick={() => session.setOpen(false)}>
            <X aria-hidden />
          </IconButton>
        </div>

        {view === 'list' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList
              ref={newButtonRef}
              currentId={conversationId}
              onOpen={session.openConversation}
              onNew={session.newConversation}
            />
          </div>
        ) : (
          <>
            <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <Thread session={session} role={role} onNew={startNew} />
            </div>
            <Composer
              draft={session.draft}
              onDraftChange={session.setDraft}
              onAsk={(question) => void session.ask(question)}
              onStop={session.stop}
              answering={answeringHere}
              answeringElsewhere={answeringElsewhere}
              busy={busy}
              problem={session.problem}
              onClearProblem={session.clearProblem}
              textareaRef={textareaRef}
            />
          </>
        )}
        <p aria-live="polite" className="sr-only">
          {announcementOf(latest)}
        </p>
      </TooltipProvider>
    </DialogPrimitive.Content>
  );
}

/** "Ask" in the header and the panel it opens. */
export function ChatPanel() {
  const session = useChatSession();
  const { data: me } = useMe();
  return (
    <DialogPrimitive.Root open={session.open} onOpenChange={session.setOpen} modal={false}>
      <DialogPrimitive.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            'text-chrome-foreground hover:bg-chrome-raised border border-white/15 hover:text-white',
            'data-[state=open]:border-brand/70 data-[state=open]:bg-chrome-raised data-[state=open]:text-white',
          )}
        >
          <Sparkles className="text-brand" aria-hidden />
          Ask
          {session.busy ? (
            <>
              <span aria-hidden className="bg-brand size-1.5 animate-pulse rounded-full" />
              <span className="sr-only">(an answer is being written)</span>
            </>
          ) : null}
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <PanelContent session={session} role={me?.role} />
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
