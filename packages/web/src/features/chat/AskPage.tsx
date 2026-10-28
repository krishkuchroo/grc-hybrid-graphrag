// The Ask page (D262; D27 #9 became a page and a panel): /ask for a new conversation and /ask/<id>
// for one of the person's own. It shows the shell's one chat session (./ChatSessionProvider), the
// one the quick panel shows, so a conversation, a question being written and an answer still
// arriving carry across.
// - The address and the session stay in step. Arriving at /ask/<id> (a link, a reload, Back or
//   Forward) opens that conversation, only when it isn't already the open one, so the draft, the
//   problem shown and an answer being written stay as they were. Arriving at /ask shows a new
//   conversation (the draft kept). A first question on /ask starts a conversation, and the address
//   becomes /ask/<id> in place (replace), so Back doesn't land on an empty page.
// - Layout: the person's conversations in a column on the left (below 1024px it folds behind
//   "Conversations" in the top bar, and shows in place of the thread); a top bar with the page's
//   title and the open conversation's; the thread in a centred column with larger type, kept at the
//   bottom while the person is there; the question box pinned under it. The page doesn't scroll, its
//   parts do.
// - An empty new conversation shows the welcome (./AskWelcome) with four starter questions.
// - Arriving, or switching conversation, puts the keyboard in the question box (on the thread when
//   the box waits). One polite live region reads each step and outcome once, never the answer's words.
// The API decides who may open which conversation and what any answer may show (D7, D50, D51): a
// conversation that can't be opened shows the panel's "couldn't be opened" problem.
import { CHAT_TEXT } from '@grc/shared';
import { useNavigate } from '@tanstack/react-router';
import { History, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useMe } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { AskWelcome } from './AskWelcome';
import { useSharedChatSession } from './ChatSessionProvider';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { announcementOf, Thread, useKeepAtBottom } from './Thread';

/** Whether a path is the Ask page's: /ask or /ask/<id>. */
export function isAskPath(pathname: string): boolean {
  return /^\/ask(\/|$)/.test(pathname);
}

export function AskPage({ conversationId }: { conversationId: string | null }) {
  const session = useSharedChatSession();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [showList, setShowList] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const listHeadingId = useId();
  const { scrollerRef, onScroll } = useKeepAtBottom(session, showList);
  const { openConversation, newConversation, busy } = session;
  const openId = session.conversationId;

  const focusBox = useCallback(() => {
    const box = textareaRef.current;
    if (box !== null && !box.disabled) box.focus();
    else scrollerRef.current?.focus();
  }, [scrollerRef]);

  // The address leads: arriving at /ask/<id> opens it unless it is already open; arriving at /ask
  // shows a new conversation. Arriving or switching puts the keyboard in the box, but not when the
  // address only caught up with a conversation that a first question started here.
  const arrived = useRef(false);
  useEffect(() => {
    const first = !arrived.current;
    arrived.current = true;
    if (conversationId !== null) {
      if (conversationId !== openId) openConversation(conversationId);
      else if (!first) return;
    } else if (openId !== null) {
      newConversation();
    }
    focusBox();
    // Only a change of address runs this (the session as it is then); the session's own changes
    // are followed below.
  }, [conversationId]);

  // The session's open conversation changed here (a first question on /ask started one): the
  // address follows it in place, so Back doesn't land on an empty page.
  const lastOpenId = useRef(openId);
  useEffect(() => {
    const before = lastOpenId.current;
    lastOpenId.current = openId;
    if (before === openId || openId === conversationId) return;
    if (openId === null) void navigate({ to: '/ask', replace: true });
    else void navigate({ to: '/ask/$id', params: { id: openId }, replace: true });
  }, [openId, conversationId, navigate]);

  // Showing the list (below 1024px) and going back move the keyboard with them.
  const firstShow = useRef(true);
  useEffect(() => {
    if (firstShow.current) {
      firstShow.current = false;
      return;
    }
    if (showList) newButtonRef.current?.focus();
    else focusBox();
  }, [showList, focusBox]);

  // When an answer ends, the box is usable again: give it the keyboard back if it was lost.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && !showList) {
      const active = document.activeElement;
      if (active === null || active === document.body || active === scrollerRef.current) focusBox();
    }
    wasBusy.current = busy;
  }, [busy, showList, focusBox, scrollerRef]);

  const openFromList = (id: string) => {
    setShowList(false);
    if (id === conversationId) focusBox();
    else void navigate({ to: '/ask/$id', params: { id } });
  };

  const startNew = () => {
    setShowList(false);
    if (conversationId !== null) {
      void navigate({ to: '/ask' });
      return;
    }
    if (openId !== null) newConversation();
    focusBox();
  };

  const answeringHere = session.answering !== null && session.answering.conversationId === openId;
  const answeringElsewhere = session.answering !== null && !answeringHere;
  const title = openId === null ? CHAT_TEXT.newConversation : (session.conversation.data?.title ?? '');
  const firstName = me?.user.name.trim().split(/\s+/)[0];
  const startersWait = busy || session.problem?.kind === 'rate_limited';

  return (
    <TooltipProvider>
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="bg-card flex h-14 min-w-0 items-center gap-3 border-b px-4 sm:px-6 lg:col-start-2 lg:row-start-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="aria-expanded:bg-accent aria-expanded:text-accent-foreground lg:hidden"
            aria-expanded={showList}
            aria-controls={listId}
            onClick={() => setShowList((shown) => !shown)}
          >
            <History aria-hidden />
            Conversations
          </Button>
          <span
            aria-hidden
            className="bg-chrome text-brand hidden size-8 shrink-0 place-items-center rounded-full sm:grid"
          >
            <Sparkles className="size-4" />
          </span>
          <div className="grid min-w-0 flex-1 leading-tight">
            <h1 className="text-[15px] font-semibold">Ask</h1>
            <p className="text-muted-foreground truncate text-xs">{title}</p>
          </div>
        </div>

        <aside
          id={listId}
          aria-labelledby={listHeadingId}
          className={cn(
            'bg-card row-start-2 min-h-0 flex-col lg:col-start-1 lg:row-[1/span_2] lg:flex lg:border-r',
            showList ? 'flex' : 'hidden',
          )}
        >
          <div className="hidden h-14 shrink-0 items-center border-b px-4 lg:flex">
            <h2 id={listHeadingId} className="text-sm font-semibold">
              Conversations
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList ref={newButtonRef} currentId={openId} onOpen={openFromList} onNew={startNew} />
          </div>
        </aside>

        <section
          aria-label="Conversation"
          className={cn('row-start-2 min-h-0 flex-col lg:col-start-2 lg:flex', showList ? 'hidden' : 'flex')}
        >
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            tabIndex={-1}
            className="focus-visible:outline-ring/40 min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <Thread
              session={session}
              role={me?.role}
              onNew={startNew}
              size="page"
              empty={<AskWelcome firstName={firstName} disabled={startersWait} onAsk={(q) => void session.ask(q)} />}
            />
          </div>
          <div className="mx-auto w-full max-w-[48rem] px-4 pt-2 pb-5 sm:px-6">
            <Composer
              size="page"
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
          </div>
        </section>

        <p aria-live="polite" className="sr-only">
          {announcementOf(session.latest)}
        </p>
      </div>
    </TooltipProvider>
  );
}
