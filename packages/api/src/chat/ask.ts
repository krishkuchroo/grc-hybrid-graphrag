// One question, asked and answered (S6-006 behaviour 2 and 3; D3 (b), D23, D45.6, D45.7, D45.8, D47,
// D48, D52; S6 shared notes, "One question, step by step", "Gemma's queue" and "The stream").
// 1. It takes a Gemma turn (S6-002), sending `queued` with each new place while it waits. The turn
//    holds the program's one Gemma slot for both Gemma steps (the graph query, then the answer), so
//    nothing overtakes it halfway.
// 2. `step searching_documents`, then (hybrid) `step querying_graph` as the graph query is written:
//    `Retrieval.retrieve` with the turn's session as the model. Everything retrieval returns is
//    already limited to what the asker may see (D23).
// 3. `sources`, with the fallback reason when the graph path failed (the answer then uses documents
//    only, D45.7).
// 4. No sources: the plain "nothing found" words, without asking Gemma (S6-Q6).
// 5. Otherwise `step writing_answer`, and Gemma's answer (`chat-answer-v1`, ./answer-prompt.ts)
//    streamed as `token` events, at most 1,024 tokens and 180 s. Earlier turns aren't sent (S6-Q4).
// 6. The citations are the source numbers the answer uses that match a source (./citations.ts).
// 7. The message is saved with its `chat.asked` entry in one transaction (ChatService.saveMessage),
//    then `done` with the saved message.
// When things go wrong:
// - The person leaves or presses Stop (the connection closes): the turn's signal stops Gemma and
//   frees the slot at once; the message is saved `stopped` with what was written, and audited. A
//   person who leaves while waiting leaves the queue, and the question is saved `stopped` too.
// - The answer's time limit or token cap: saved `stopped`, with what was written.
// - Gemma or bge-m3 can't be reached: an `error` event with `assistant_unavailable`, and the message
//   saved `failed` (no answer, no citations), and audited.
// - Anything else: an `error` event with `internal_error` and a reference ID, the message saved
//   `failed`.
// Logs (D163): IDs, counts, times, model names and codes only; never the question, the answer, a
// passage, the graph query or a record's name.
import {
  CHAT_ERRORS,
  CHAT_PROMPT_VERSIONS,
  CHAT_TEXT,
  SEARCH_LIMITS,
  type AnswerSource,
  type ChatMessageStatus,
  type ChatStreamEvent,
  type GraphFallbackReason,
  type Label,
} from '@grc/shared';
import type { Logger } from 'pino';
import { AiStopped, isAiFailure, isAiStopped } from '../ai/ai-failure.js';
import type { TextAnswer, TextModel, TextModelSession, TextRequest, TextStreamEnding } from '../ai/text-model.js';
import { ApiError, errorKind, newReferenceId } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import type { Caller } from '../records/records.service.js';
import type { GraphQueryModel, Retrieval, RetrievalResult, SearchCaller } from '../search/retrieval.js';
import { ANSWER_PROMPT_VERSION, answerRequest } from './answer-prompt.js';
import type { ChatMessageDbRow } from './chat.schema.js';
import { visibleMessage, type AskInput, type ChatService } from './chat.service.js';
import { citedNumbers, citedSources, shownCitation, storedCitation } from './citations.js';

/** Where the events go: the event stream, or anything else that takes them in order. */
export interface AskEvents {
  send(event: ChatStreamEvent): Promise<void>;
}

/** The error codes an ask can end with besides S6-001's: an unexpected failure. */
const INTERNAL_ERROR = {
  code: 'internal_error',
  message: 'Something went wrong. Quote the reference ID if you report it.',
} as const;

type FailureCode = 'assistant_unavailable' | 'internal_error';

type Stage = 'waiting' | 'searching' | 'answering';

/** What one ask has found and written so far. */
interface AskState {
  stage: Stage;
  /** The turn's wait for the Gemma slot; null until the turn started. */
  waitedMs: number | null;
  searchingMs: number | null;
  firstWordsMs: number | null;
  retrieval: RetrievalResult | null;
  answer: string;
  ending: TextStreamEnding | null;
  /** The graph query was asked of Gemma. */
  graphAsked: boolean;
  /** The answer was asked of Gemma. */
  answerAsked: boolean;
  model: string | null;
}

export function searchCallerOf(caller: Caller): SearchCaller {
  return {
    orgId: caller.orgId,
    userId: caller.userId,
    role: caller.role,
    clearance: caller.clearance,
    kind: caller.apiKeyId !== undefined ? 'api_key' : 'person',
  };
}

/** A graph query the message can store: 1 to 2,000 characters, else none. */
function storableQuery(query: string | null | undefined): string | null {
  if (typeof query !== 'string') return null;
  return query.length >= 1 && query.length <= SEARCH_LIMITS.graphQueryMaxLength ? query : null;
}

/** Whether an error means Gemma or bge-m3 can't be reached. */
function isUnavailable(err: unknown): boolean {
  if (isAiFailure(err)) return true;
  return err instanceof ApiError && (err.code === 'assistant_unavailable' || err.getStatus() === 503);
}

export interface AskRunnerDeps {
  textModel: TextModel;
  retrieval: Retrieval;
  chat: Pick<ChatService, 'saveMessage'>;
  log?: Logger;
  /** For tests: the clock, in milliseconds. */
  now?: () => number;
}

export class AskRunner {
  private readonly textModel: TextModel;
  private readonly retrieval: Retrieval;
  private readonly chat: Pick<ChatService, 'saveMessage'>;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(deps: AskRunnerDeps) {
    this.textModel = deps.textModel;
    this.retrieval = deps.retrieval;
    this.chat = deps.chat;
    this.log = deps.log ?? createLogger().child({ context: 'ChatAsk' });
    this.now = deps.now ?? (() => performance.now());
  }

  /** Asks the question and sends its events, in order. `signal` aborts when the person leaves.
   * Never rejects: every failure ends with an `error` event. */
  async run(input: AskInput, events: AskEvents, signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    const askedAt = new Date();
    const since = (): number => Math.max(0, Math.round(this.now() - startedAt));
    const send = async (event: ChatStreamEvent): Promise<void> => {
      try {
        await events.send(event);
      } catch {
        // A stream that can't be written to any more is the same as a person who left.
      }
    };
    const state: AskState = {
      stage: 'waiting',
      waitedMs: null,
      searchingMs: null,
      firstWordsMs: null,
      retrieval: null,
      answer: '',
      ending: null,
      graphAsked: false,
      answerAsked: false,
      model: null,
    };

    let status: ChatMessageStatus;
    let failure: { code: FailureCode; err: unknown } | null = null;
    try {
      await this.textModel.turn((session) => this.work(session, input, state, send, signal, since), {
        signal,
        onPosition: (position) => send({ event: 'queued', position }),
      });
      status = state.ending === 'finished' ? 'answered' : 'stopped';
    } catch (err) {
      if (isAiStopped(err) || signal.aborted) {
        status = 'stopped';
      } else if (state.stage === 'answering' && isAiFailure(err, 'timed_out')) {
        // The answer's time limit, with nothing written.
        status = 'stopped';
      } else if (isUnavailable(err)) {
        status = 'failed';
        failure = { code: 'assistant_unavailable', err };
      } else {
        status = 'failed';
        failure = { code: 'internal_error', err };
      }
    }
    if (state.waitedMs === null) state.waitedMs = since();

    const retrieval = state.retrieval;
    const sources: AnswerSource[] = retrieval?.sources ?? [];
    const answer = status === 'failed' ? '' : state.answer;
    const cited = status !== 'failed' && state.answerAsked ? citedSources(answer, sources) : [];
    const ignored = status !== 'failed' && state.answerAsked ? citedNumbers(answer, sources).ignored.length : 0;
    const hybrid = input.mode === 'hybrid';
    const graphQuery = hybrid ? storableQuery(retrieval?.graph.query) : null;
    const fallback: GraphFallbackReason | null = hybrid ? (retrieval?.graph.fallback ?? null) : null;
    const graphAsked = hybrid && (state.graphAsked || graphQuery !== null);
    const model = state.model ?? (graphAsked ? this.textModel.modelName : null);
    const label: Label = retrieval?.label ?? 'public';

    let saved: ChatMessageDbRow;
    try {
      saved = await this.chat.saveMessage(input.caller, input.conversationId, {
        question: input.question,
        answer,
        status,
        mode: input.mode,
        fallbackReason: fallback,
        citations: cited.map(storedCitation),
        graphQuery,
        model,
        promptVersions: {
          graphQuery: graphAsked ? CHAT_PROMPT_VERSIONS.graphQuery : null,
          answer: state.answerAsked ? ANSWER_PROMPT_VERSION : null,
        },
        timings: {
          waitedMs: state.waitedMs,
          searchingMs: state.searchingMs,
          firstWordsMs: status === 'failed' ? null : state.firstWordsMs,
          totalMs: since(),
        },
        label,
        askedAt,
        graphRan: hybrid && retrieval?.graph.ran === true,
      });
    } catch (err) {
      const referenceId = newReferenceId();
      this.log.error(
        { ...errorKind(err), referenceId, orgId: input.caller.orgId, conversationId: input.conversationId },
        'chat message could not be saved',
      );
      await send({ event: 'error', code: INTERNAL_ERROR.code, message: INTERNAL_ERROR.message, referenceId });
      return;
    }

    const where = {
      orgId: input.caller.orgId,
      conversationId: input.conversationId,
      messageId: saved.id,
      mode: input.mode,
      status,
      fallback,
      graphRan: hybrid && retrieval?.graph.ran === true,
      sources: sources.length,
      cited: cited.length,
      ignoredCitations: ignored,
      waitedMs: state.waitedMs,
      searchingMs: state.searchingMs,
      firstWordsMs: state.firstWordsMs,
      totalMs: since(),
      model,
    };

    if (failure !== null) {
      const referenceId = newReferenceId();
      if (failure.code === 'assistant_unavailable') {
        this.log.warn(
          {
            ...where,
            code: failure.code,
            referenceId,
            aiCode: isAiFailure(failure.err) ? failure.err.code : undefined,
          },
          'chat question failed',
        );
        await send({
          event: 'error',
          code: failure.code,
          message: CHAT_ERRORS.assistant_unavailable.message,
          referenceId,
        });
      } else {
        this.log.error(
          { ...where, ...errorKind(failure.err), code: failure.code, referenceId },
          'chat question failed',
        );
        await send({ event: 'error', code: INTERNAL_ERROR.code, message: INTERNAL_ERROR.message, referenceId });
      }
      return;
    }

    this.log.info(where, status === 'answered' ? 'chat question answered' : 'chat question stopped');
    await send({ event: 'done', message: visibleMessage(saved, cited.map(shownCitation)) });
  }

  /** The work done in the question's Gemma turn. */
  private async work(
    session: TextModelSession,
    input: AskInput,
    state: AskState,
    send: (event: ChatStreamEvent) => Promise<void>,
    signal: AbortSignal,
    since: () => number,
  ): Promise<void> {
    state.waitedMs = session.waitedMs;
    if (signal.aborted) throw new AiStopped();

    state.stage = 'searching';
    await send({ event: 'step', step: 'searching_documents' });
    let graphStepSent = false;
    const graphStep = async (): Promise<void> => {
      if (graphStepSent || input.mode !== 'hybrid') return;
      graphStepSent = true;
      await send({ event: 'step', step: 'querying_graph' });
    };
    // The graph query is written in this turn's slot; its step is sent as it starts.
    const graphModel: GraphQueryModel = {
      generate: async <T>(request: TextRequest<T>): Promise<TextAnswer<T>> => {
        state.graphAsked = true;
        state.model = session.modelName;
        await graphStep();
        return session.generate(request);
      },
    };
    const searchStarted = this.now();
    const retrieval = await this.retrieval.retrieve(searchCallerOf(input.caller), input.question, {
      mode: input.mode,
      model: graphModel,
    });
    state.searchingMs = Math.max(0, Math.round(this.now() - searchStarted));
    state.retrieval = retrieval;
    await graphStep();
    if (signal.aborted) throw new AiStopped();

    const fallback = input.mode === 'hybrid' ? retrieval.graph.fallback : null;
    await send({
      event: 'sources',
      sources: retrieval.sources,
      ...(fallback !== null ? { fallback } : {}),
    });

    if (retrieval.sources.length === 0) {
      state.answer = CHAT_TEXT.nothingFound;
      state.firstWordsMs = since();
      await send({ event: 'token', text: state.answer });
      state.ending = 'finished';
      return;
    }

    state.stage = 'answering';
    await send({ event: 'step', step: 'writing_answer' });
    state.answerAsked = true;
    state.model = session.modelName;
    const result = await session.stream({
      ...answerRequest(retrieval.context, input.question),
      maxOutputTokens: SEARCH_LIMITS.answerMaxTokens,
      timeoutMs: SEARCH_LIMITS.answerTimeoutMs,
      signal,
      onText: async (text) => {
        if (state.firstWordsMs === null) state.firstWordsMs = since();
        state.answer += text;
        await send({ event: 'token', text });
      },
    });
    state.model = result.model;
    state.ending = result.ending;
  }
}
