// Screen 9's quick panel (S6-007, D27 #9 as D262 changed it), after ServiceNow's assistant panel
// (D2). "Ask" in the header, for every signed-in person (the Chat cell is every role's, D50), opens
// it on the right, over whatever screen is showing. It isn't modal: the screen behind it stays
// usable, it stays open while the person moves between screens (a record chip opens the record's
// page beside it), and it closes with its close button or Esc. Opening puts the keyboard in the
// question box; closing gives it back to "Ask".
// - It shows the shell's one chat session (./ChatSessionProvider), the same one the Ask page shows,
//   so the conversation, the question being written and an answer still arriving carry across.
// - "Open on the full page" goes to the Ask page with the open conversation (/ask/<id>), or /ask
//   for a new one, the question being written kept; the panel closes as the page opens.
// - On the Ask page (/ask, /ask/<id>) the header's "Ask" isn't shown and the panel doesn't open; an
//   open panel closes as the person arrives there, by any way.
// - Conversations are the person's own (./ConversationList); a new one is started by its first
//   question, so no empty conversation is left behind.
// - The panel always searches both documents and the graph (S6-Q3).
// - Steps and outcomes are read out to screen readers once each (a polite live region); the answer's
//   words are not, as they arrive.
// The API decides what anyone may see or ask (D7): this panel only shows its answers.
import { CHAT_TEXT } from '@grc/shared';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, History, Maximize2, Sparkles, SquarePen, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMe } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { isAskPath } from './AskPage';
import { useSharedChatSession } from './ChatSessionProvider';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { announcementOf, Thread, useKeepAtBottom } from './Thread';
import type { ChatSession } from './useChatSession';
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

function PanelContent({
  session,
  role,
  onExpand,
}: {
  session: ChatSession;
  role: string | undefined;
  onExpand: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const { view, conversationId, busy } = session;
  const latest = session.latest;
  const title = conversationId === null ? CHAT_TEXT.newConversation : (session.conversation.data?.title ?? '');
  const { scrollerRef, onScroll } = useKeepAtBottom(session, view);

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

  const startNew = () => {
    session.newConversation();
    if (view === 'thread') focusBox();
  };

  const answeringHere = session.answering !== null && session.answering.conversationId === conversationId;
  const answeringElsewhere = session.answering !== null && !answeringHere;

  const expandButton = (
    <IconButton label="Open on the full page" onClick={onExpand}>
      <Maximize2 aria-hidden />
    </IconButton>
  );

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
          {expandButton}
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
            <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <Thread session={session} role={role} onNew={startNew} empty={<EmptyThread />} />
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

/** "Ask" in the header and the panel it opens; neither shows on the Ask page itself. */
export function ChatPanel() {
  const session = useSharedChatSession();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const onAskPage = useLocation({ select: (location) => isAskPath(location.pathname) });
  const { open, setOpen } = session;

  // Arriving on the Ask page, by any way, closes the panel: the page shows the same conversation.
  useEffect(() => {
    if (onAskPage && open) setOpen(false);
  }, [onAskPage, open, setOpen]);

  const expand = () => {
    const id = session.conversationId;
    const going = id === null ? navigate({ to: '/ask' }) : navigate({ to: '/ask/$id', params: { id } });
    void going.then(() => setOpen(false));
  };

  return (
    <DialogPrimitive.Root open={open && !onAskPage} onOpenChange={setOpen} modal={false}>
      {onAskPage ? null : (
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
      )}
      <DialogPrimitive.Portal>
        <PanelContent session={session} role={me?.role} onExpand={expand} />
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
