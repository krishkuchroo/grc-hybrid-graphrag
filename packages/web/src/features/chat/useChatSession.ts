// The chat panel's state (S6-007): whether it is open, which conversation it shows (or a new one,
// started on its first question), the question being written, and the questions asked in this
// session that the conversation, read again, doesn't hold yet. It lives in the shell, through
// ChatSessionProvider, so it stays as the person moves between screens and while the panel is
// closed, and the Ask page shows the same session (D262); an answer keeps arriving behind a closed
// panel.
// - One question at a time: the box is disabled while an answer is being written (behaviour 3).
// - The answer's events arrive through ./stream.ts. `done` carries the saved message; Stop closes
//   the connection, and the API saves what was written as stopped; an `error` event or a lost
//   connection is shown in plain words. In every case the conversation is read again until the
//   saved message is there, and the session's copy gives way to it.
// - A refusal before the stream starts (rate limited, session ended, not found…) saves nothing: the
//   question stays in the box, with the refusal above it.
import { SEARCH_LIMITS, type AnswerSource, type ChatStep, type GraphFallbackReason } from '@grc/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/api/client';
import { askQuestion, AskAborted } from './stream';
import { chatKeys, fetchConversation, useConversation, type Conversation, type Message } from './useChat';

export type TurnPhase = 'sending' | 'queued' | 'working' | 'answering' | 'answered' | 'stopped' | 'failed';

/** What went wrong with a question, as the API said it (code, message and reference ID). */
export interface TurnFailure {
  code: string;
  message: string;
  referenceId?: string | undefined;
}

/** A question asked in this session, as its events have told it so far. */
export interface LiveTurn {
  key: number;
  conversationId: string;
  question: string;
  /** Where its saved message goes: how many messages the conversation holds before it. */
  baseCount: number;
  phase: TurnPhase;
  /** The place in Gemma's queue while waiting (1 means next). */
  position: number | null;
  /** The steps reached, in order. */
  steps: ChatStep[];
  /** What the answer may cite, once found. */
  sources: AnswerSource[] | null;
  fallback: GraphFallbackReason | null;
  answer: string;
  /** The saved message, once `done` has come. */
  saved: Message | null;
  failure: TurnFailure | null;
  askedAt: string;
  /** Reading it back gave up: the API may never have saved it. */
  unsaved: boolean;
}

/** A question that wasn't taken: the 10-a-minute limit (until when), or another refusal. */
export type ComposerProblem = { kind: 'rate_limited'; until: number } | { kind: 'refused'; error: unknown };

export type PanelView = 'thread' | 'list';

const BUSY_PHASES: ReadonlySet<TurnPhase> = new Set(['sending', 'queued', 'working', 'answering']);

export function isBusy(turn: LiveTurn | null | undefined): boolean {
  return turn !== null && turn !== undefined && BUSY_PHASES.has(turn.phase);
}

/** Whether a conversation, as last read, still lacks the turn's message: shown while it is being
 * answered, and after it ends until the conversation, read again, holds its saved message. */
export function isPending(turn: LiveTurn, messages: readonly Message[] | undefined): boolean {
  if (isBusy(turn) || messages === undefined) return true;
  if (turn.saved !== null) {
    const id = turn.saved.id;
    return !messages.some((m) => m.id === id);
  }
  return messages.length <= turn.baseCount;
}

/** The session's turns the open conversation shows after its own messages, oldest first. */
export function turnsShown(
  turns: readonly LiveTurn[],
  conversationId: string | null,
  messages: readonly Message[] | undefined,
): LiveTurn[] {
  return turns.filter((t) => t.conversationId === conversationId && isPending(t, messages));
}

/** After an answer ends, the conversation is read again after these waits until the saved message
 * is there (a stopped answer is saved a moment after the connection closes). */
const SETTLE_DELAYS_MS = [0, 400, 1_000, 2_000, 4_000];

/** When the API gives no Retry-After for a 429. */
const DEFAULT_RETRY_SECONDS = 60;

const CONNECTION_LOST: TurnFailure = {
  code: 'connection_lost',
  message: 'The connection closed before the answer finished.',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useChatSession() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>('thread');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [starting, setStarting] = useState(false);
  const [failures, setFailures] = useState<Readonly<Record<string, TurnFailure>>>({});
  const [problem, setProblem] = useState<ComposerProblem | null>(null);

  const conversation = useConversation(conversationId);

  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const keyRef = useRef(0);
  const turnsRef = useRef<LiveTurn[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // Once the open conversation holds a turn's saved message, the session's copy gives way to it.
  const messages = conversation.data?.messages;
  useEffect(() => {
    if (messages === undefined) return;
    setTurns((all) => {
      const kept = all.filter((t) => t.conversationId !== conversationId || isPending(t, messages));
      return kept.length === all.length ? all : kept;
    });
  }, [turns, messages, conversationId]);

  const update = useCallback((key: number, change: (turn: LiveTurn) => LiveTurn) => {
    setTurns((all) => all.map((t) => (t.key === key ? change(t) : t)));
  }, []);

  const drop = useCallback((key: number) => {
    setTurns((all) => all.filter((t) => t.key !== key));
  }, []);

  /** Reads the conversation again until it holds the turn's saved message. */
  const settle = useCallback(
    async (turn: LiveTurn, failure: TurnFailure | null): Promise<void> => {
      try {
        for (const delay of SETTLE_DELAYS_MS) {
          if (delay > 0) await sleep(delay);
          if (!mounted.current) return;
          let read: Conversation;
          try {
            read = await queryClient.fetchQuery({
              queryKey: chatKeys.one(turn.conversationId),
              queryFn: () => fetchConversation(turn.conversationId),
              staleTime: 0,
            });
          } catch {
            continue;
          }
          const saved = read.messages[turn.baseCount];
          if (saved !== undefined) {
            if (failure !== null) setFailures((all) => ({ ...all, [saved.id]: failure }));
            // Another conversation's turn isn't shown, so it can go now; the open one's goes once
            // the panel shows the saved message.
            if (turn.conversationId !== conversationIdRef.current) drop(turn.key);
            return;
          }
        }
        update(turn.key, (t) => ({ ...t, unsaved: true }));
      } finally {
        void queryClient.invalidateQueries({ queryKey: chatKeys.list });
      }
    },
    [drop, queryClient, update],
  );

  const ask = useCallback(
    async (text: string): Promise<void> => {
      const question = text.trim();
      if (question === '' || question.length > SEARCH_LIMITS.questionMaxLength || busyRef.current) return;
      busyRef.current = true;
      setProblem(null);

      const refuse = (err: unknown): void => {
        setDraft((current) => (current.trim() === '' ? question : current));
        if (err instanceof ApiError && err.status === 429) {
          const seconds = err.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
          setProblem({ kind: 'rate_limited', until: Date.now() + seconds * 1000 });
        } else {
          setProblem({ kind: 'refused', error: err });
        }
      };

      let id = conversationId;
      if (id === null) {
        setStarting(true);
        try {
          const started = await api.postChatConversations({});
          queryClient.setQueryData(chatKeys.one(started.id), started);
          void queryClient.invalidateQueries({ queryKey: chatKeys.list });
          id = started.id;
          setConversationId(id);
        } catch (err) {
          busyRef.current = false;
          refuse(err);
          return;
        } finally {
          setStarting(false);
        }
      }
      const askedIn = id;

      // Its message goes after the conversation's, and after any earlier question of this session
      // the conversation hasn't been read back with yet.
      const held = queryClient.getQueryData<Conversation>(chatKeys.one(askedIn))?.messages.length ?? 0;
      const after = turnsRef.current
        .filter((t) => t.conversationId === askedIn && !t.unsaved)
        .reduce((n, t) => Math.max(n, t.baseCount + 1), 0);
      keyRef.current += 1;
      const turn: LiveTurn = {
        key: keyRef.current,
        conversationId: askedIn,
        question,
        baseCount: Math.max(held, after),
        phase: 'sending',
        position: null,
        steps: [],
        sources: null,
        fallback: null,
        answer: '',
        saved: null,
        failure: null,
        askedAt: new Date().toISOString(),
        unsaved: false,
      };
      setTurns((all) => [...all, turn]);
      setDraft('');
      const abort = new AbortController();
      controller.current = abort;

      let failure: TurnFailure | null = null;
      try {
        const ending = await askQuestion(askedIn, question, {
          signal: abort.signal,
          onEvent: (event) => {
            switch (event.event) {
              case 'queued':
                update(turn.key, (t) => ({ ...t, phase: 'queued', position: event.position }));
                break;
              case 'step':
                update(turn.key, (t) => ({
                  ...t,
                  phase: event.step === 'writing_answer' ? 'answering' : 'working',
                  position: null,
                  steps: t.steps.includes(event.step) ? t.steps : [...t.steps, event.step],
                }));
                break;
              case 'sources':
                update(turn.key, (t) => ({ ...t, sources: event.sources, fallback: event.fallback ?? null }));
                break;
              case 'token':
                update(turn.key, (t) => ({ ...t, phase: 'answering', position: null, answer: t.answer + event.text }));
                break;
              case 'done':
                update(turn.key, (t) => ({ ...t, phase: 'answered', saved: event.message }));
                break;
              case 'error': {
                const said: TurnFailure = { code: event.code, message: event.message, referenceId: event.referenceId };
                failure = said;
                update(turn.key, (t) => ({ ...t, phase: 'failed', failure: said }));
                break;
              }
            }
          },
        });
        if (ending === 'cut') {
          failure = CONNECTION_LOST;
          update(turn.key, (t) => ({ ...t, phase: 'failed', failure: CONNECTION_LOST }));
        }
        void settle(turn, failure);
      } catch (err) {
        if (err instanceof AskAborted) {
          update(turn.key, (t) => ({ ...t, phase: 'stopped', position: null }));
          void settle(turn, null);
        } else {
          // Refused before the stream started: nothing was saved.
          drop(turn.key);
          refuse(err);
        }
      } finally {
        if (controller.current === abort) controller.current = null;
        busyRef.current = false;
      }
    },
    [conversationId, drop, queryClient, settle, update],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  const clearProblem = useCallback(() => setProblem(null), []);

  const openConversation = useCallback((id: string) => {
    setConversationId(id);
    setView('thread');
    setProblem(null);
  }, []);

  const newConversation = useCallback(() => {
    setConversationId(null);
    setView('thread');
    setProblem(null);
  }, []);

  const answering = turns.find((t) => isBusy(t)) ?? null;

  return {
    open,
    setOpen,
    view,
    setView,
    conversationId,
    conversation,
    draft,
    setDraft,
    turns,
    /** The question being answered now, in any conversation. */
    answering,
    /** The latest question of the session, for the screen reader's announcements. */
    latest: turns[turns.length - 1] ?? null,
    /** Starting a conversation or answering a question: the box waits. */
    busy: starting || answering !== null,
    starting,
    failures,
    problem,
    clearProblem,
    ask,
    stop,
    openConversation,
    newConversation,
  };
}

export type ChatSession = ReturnType<typeof useChatSession>;
