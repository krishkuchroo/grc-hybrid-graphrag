// The text model on an OpenAI-compatible server (D236, D243): the user's Unsloth Studio model
// (Qwen3.5-4B) through its local API, chosen with AI_TEXT_PROVIDER=openai-compatible. It keeps the
// whole text-model contract (text-model.ts) the way OllamaTextModel does: temperature 0 and the
// fixed seed (D45.8), answers held to the schema while the model writes (sent as a
// `response_format` JSON schema) and checked against it afterwards, with no second try (D39).
// The context size is whatever the model was loaded with in Unsloth: this API can't set it per call,
// so AI_TEXT_CONTEXT_TOKENS tells the API what it is (D260).
//
// One call at a time per program (D34, D72): it shares the program's one model slot with
// OllamaTextModel (PROGRAM_GATE), whichever provider is set. Turns (D48) work as Ollama's do.
//
// Thinking text never reaches an answer (D243): every request asks the server not to think, any
// `<think>…</think>` block that still comes back is turned into reasoning by the AI SDK's
// middleware before the schema check and before a piece is handed over, and reasoning is never
// handed over, kept, saved or logged. A stream that ends with no text is a failure, never an empty
// answer.
//
// Failures map as Ollama's do (ai-failure.ts), and a refused key (HTTP 401 or 403) is `unavailable`
// too, like a stopped server (D242): jobs put the work off, chat says the assistant is unavailable.
//
// Logs (D163): the model, timings, token counts, failure codes and HTTP status only. Never the
// instructions, the data, the answer, the thinking, the SDK's errors, the address or the key.
import {
  APICallError,
  extractReasoningMiddleware,
  generateText,
  Output,
  RetryError,
  streamText,
  wrapLanguageModel,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai';
import type { Logger } from 'pino';
import { createLogger } from '../common/logger.js';
import { AiFailure, AiInputError, AiStopped, toAiError, type AiCallError } from './ai-failure.js';
import {
  DEFAULT_TEXT_CONTEXT_TOKENS,
  MAX_TEXT_CONTEXT_TOKENS,
  MIN_TEXT_CONTEXT_TOKENS,
  type OpenAiCompatibleSettings,
} from './ai-settings.js';
import type { FetchLike } from './ollama-provider.js';
import {
  checkedSchema,
  checkRequest,
  checkSignal,
  checkStreamRequest,
  errorTypeOf,
  positiveWhole,
  PROGRAM_GATE,
  since,
  streamFailure,
  TEXT_MODEL_SEED,
  TEXT_MODEL_TEMPERATURE,
  TEXT_MODEL_TIMEOUT_MS,
} from './ollama-text-model.js';
import { createOpenAiCompatibleProvider } from './openai-compatible-provider.js';
import { SerialGate } from './serial-gate.js';
import type {
  TextAnswer,
  TextModel,
  TextModelSession,
  TextRequest,
  TextStreamAnswer,
  TextStreamEnding,
  TextStreamRequest,
  TurnOptions,
} from './text-model.js';

export interface OpenAiCompatibleTextModelOptions {
  connection: OpenAiCompatibleSettings;
  /** The model's ID on the server (from `GET /v1/models`). */
  model: string;
  /** The context the model was loaded with on the server (AI_TEXT_CONTEXT_TOKENS, D260); 18,432
   * when not given. */
  contextTokens?: number;
  log?: Logger;
  /** Stands in for the network, for tests. Still limited to the connection's address. */
  fetch?: FetchLike;
  /** The time limit of a call that sets none. */
  timeoutMs?: number;
  /** For tests: a gate of their own instead of the program's. */
  gate?: SerialGate;
}

/** The tag Qwen3.5 (D243) wraps its thinking in, when it writes any into the answer text. */
const THINKING_TAG = 'think';

/**
 * The per-call settings (D45.8, D243): temperature 0, the fixed seed, the token cap when the
 * request sets one, and the switch that asks the server's chat template not to think
 * (`chat_template_kwargs`, which llama-server accepts). The provider copies the unknown key into
 * the request body; it reads per-call options under its name in camelCase (`openaiCompatible`).
 */
function callSettings(maxOutputTokens: number | undefined) {
  return {
    temperature: TEXT_MODEL_TEMPERATURE,
    seed: TEXT_MODEL_SEED,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    providerOptions: {
      openaiCompatible: { chat_template_kwargs: { enable_thinking: false } },
    },
  };
}

/** The HTTP status of a refused key (401 or 403), when that is what the error is (D242). */
function refusedKeyStatus(err: unknown): number | undefined {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  if (!APICallError.isInstance(cause)) return undefined;
  const status = cause.statusCode;
  return status === 401 || status === 403 ? status : undefined;
}

/** The context size given: a whole number from 2,048 to 262,144, as AI_TEXT_CONTEXT_TOKENS allows. */
function contextTokensOption(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TEXT_CONTEXT_TOKENS;
  if (!Number.isInteger(value) || value < MIN_TEXT_CONTEXT_TOKENS || value > MAX_TEXT_CONTEXT_TOKENS) {
    throw new AiInputError(
      `contextTokens must be a whole number from ${MIN_TEXT_CONTEXT_TOKENS} to ${MAX_TEXT_CONTEXT_TOKENS}`,
    );
  }
  return value;
}

export class OpenAiCompatibleTextModel implements TextModel {
  readonly modelName: string;
  readonly contextTokens: number;
  private readonly model: LanguageModel;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly gate: SerialGate;

  constructor(opts: OpenAiCompatibleTextModelOptions) {
    this.modelName = opts.model;
    this.contextTokens = contextTokensOption(opts.contextTokens);
    // Always an object, never a plain model string (that would go to the AI SDK's hosted gateway).
    this.model = wrapLanguageModel({
      model: createOpenAiCompatibleProvider({ ...opts.connection, fetch: opts.fetch }).chatModel(this.modelName),
      middleware: extractReasoningMiddleware({ tagName: THINKING_TAG }),
    });
    this.log = (opts.log ?? createLogger()).child({ context: 'AiTextModel' });
    this.timeoutMs = positiveWhole(opts.timeoutMs, 'timeoutMs') ?? TEXT_MODEL_TIMEOUT_MS;
    this.gate = opts.gate ?? PROGRAM_GATE;
  }

  async generate<T>(request: TextRequest<T>): Promise<TextAnswer<T>> {
    checkRequest(request);
    const queuedAt = performance.now();
    return this.gate.run(() => this.callGenerate(request, since(queuedAt)));
  }

  async stream(request: TextStreamRequest): Promise<TextStreamAnswer> {
    checkStreamRequest(request);
    const { signal } = request;
    const queuedAt = performance.now();
    return this.gate.run(() => this.callStream(request, since(queuedAt), signal === undefined ? [] : [signal]), {
      signal,
    });
  }

  async turn<T>(work: (session: TextModelSession) => Promise<T>, options: TurnOptions = {}): Promise<T> {
    if (typeof work !== 'function') throw new AiInputError('A turn needs its work.');
    const { onPosition, signal } = options;
    if (onPosition !== undefined && typeof onPosition !== 'function') {
      throw new AiInputError('onPosition must be a function.');
    }
    checkSignal(signal);
    const queuedAt = performance.now();
    return this.gate.run(
      async () => {
        const waitedMs = since(queuedAt);
        const heldFrom = performance.now();
        const { session, close } = this.openSession(waitedMs, signal);
        try {
          return await work(session);
        } finally {
          close();
          this.log.debug(
            { model: this.modelName, waitedMs, heldMs: since(heldFrom), stopped: signal?.aborted === true },
            'text model turn ended',
          );
        }
      },
      { onPosition, signal },
    );
  }

  /** A turn's calls: they run in the turn's slot, one at a time, while the turn is open. */
  private openSession(
    waitedMs: number,
    turnSignal: AbortSignal | undefined,
  ): { session: TextModelSession; close: () => void } {
    const calls = new SerialGate();
    let open = true;
    const ready = (): void => {
      if (!open) throw new AiInputError('The turn has ended; its session takes no more calls.');
      if (turnSignal?.aborted) throw new AiStopped();
    };
    const session: TextModelSession = {
      modelName: this.modelName,
      waitedMs,
      generate: async <T>(request: TextRequest<T>): Promise<TextAnswer<T>> => {
        ready();
        checkRequest(request);
        const queuedAt = performance.now();
        return calls.run(async () => {
          ready();
          return this.callGenerate(request, since(queuedAt), turnSignal);
        });
      },
      stream: async (request: TextStreamRequest): Promise<TextStreamAnswer> => {
        ready();
        checkStreamRequest(request);
        const stops = [request.signal, turnSignal].filter((s): s is AbortSignal => s !== undefined);
        const queuedAt = performance.now();
        return calls.run(
          async () => {
            ready();
            return this.callStream(request, since(queuedAt), stops);
          },
          { signal: stops.length === 0 ? undefined : AbortSignal.any(stops) },
        );
      },
    };
    return {
      session,
      close: () => {
        open = false;
      },
    };
  }

  /** Logs a failure by its kind: the code or error type, the timings and the HTTP status only. */
  private logFailure(
    failure: AiFailure | AiCallError,
    details: { elapsedMs: number; waitedMs: number; pieces?: number },
    message: string,
  ): void {
    const model = this.modelName;
    if (failure instanceof AiFailure) {
      this.log.warn({ model, code: failure.code, ...details, httpStatus: failure.httpStatus }, message);
    } else {
      this.log.error({ model, errorType: failure.errorType, ...details, httpStatus: failure.httpStatus }, message);
    }
  }

  private async callGenerate<T>(request: TextRequest<T>, waitedMs: number, stop?: AbortSignal): Promise<TextAnswer<T>> {
    const model = this.modelName;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let cut: 'timed_out' | 'stopped' | undefined;
    const cutShort = (why: 'timed_out' | 'stopped'): void => {
      if (cut !== undefined) return;
      cut = why;
      controller.abort();
    };
    const timer = setTimeout(() => cutShort('timed_out'), timeoutMs);
    const onStop = (): void => cutShort('stopped');
    stop?.addEventListener('abort', onStop, { once: true });
    if (stop?.aborted) onStop();
    const startedAt = performance.now();
    try {
      const result = await generateText({
        model: this.model,
        instructions: request.instructions,
        prompt: request.data,
        // Sent as `response_format` with the JSON schema; the answer, its thinking already taken
        // out by the middleware, is then checked against the request's schema.
        output: Output.object({ schema: checkedSchema(request) }),
        // The job queue retries (D72); a retry here would hide "unavailable" for seconds.
        maxRetries: 0,
        abortSignal: controller.signal,
        ...callSettings(request.maxOutputTokens),
      });
      // An answer that lands as the caller stops is still stopped: the caller no longer wants it.
      if (cut === 'stopped') throw new AiStopped();
      const value = result.output;
      const elapsedMs = since(startedAt);
      const answer: TextAnswer<T> = { value, model, elapsedMs, waitedMs };
      if (result.usage.inputTokens !== undefined) answer.inputTokens = result.usage.inputTokens;
      if (result.usage.outputTokens !== undefined) answer.outputTokens = result.usage.outputTokens;
      this.log.info(
        { model, elapsedMs, waitedMs, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
        'text model answered',
      );
      return answer;
    } catch (err) {
      const elapsedMs = since(startedAt);
      if (cut === 'stopped') {
        this.log.info({ model, elapsedMs, waitedMs }, 'text model call stopped');
        throw new AiStopped();
      }
      const refused = cut === 'timed_out' ? undefined : refusedKeyStatus(err);
      const failure =
        refused === undefined
          ? toAiError(err, { model, elapsedMs, timedOut: cut === 'timed_out' })
          : new AiFailure('unavailable', { model, elapsedMs, httpStatus: refused });
      this.logFailure(failure, { elapsedMs, waitedMs }, 'text model call failed');
      throw failure;
    } finally {
      clearTimeout(timer);
      stop?.removeEventListener('abort', onStop);
    }
  }

  private async callStream(
    request: TextStreamRequest,
    waitedMs: number,
    stops: readonly AbortSignal[],
  ): Promise<TextStreamAnswer> {
    const model = this.modelName;
    const controller = new AbortController();
    let cut: 'time_limit' | 'stopped' | undefined;
    const cutShort = (why: 'time_limit' | 'stopped'): void => {
      if (cut !== undefined) return;
      cut = why;
      controller.abort();
    };
    const timer = setTimeout(() => cutShort('time_limit'), request.timeoutMs);
    const onStop = (): void => cutShort('stopped');
    for (const stop of stops) stop.addEventListener('abort', onStop, { once: true });
    if (stops.some((stop) => stop.aborted)) onStop();

    const startedAt = performance.now();
    let text = '';
    let pieces = 0;
    let firstTextMs: number | undefined;
    let finishReason: FinishReason | undefined;
    let usage: LanguageModelUsage | undefined;
    let failed: { error: unknown } | undefined;
    let readerFailed: { error: unknown } | undefined;
    let completed = false;
    try {
      if (cut === undefined) {
        const result = streamText({
          model: this.model,
          instructions: request.instructions,
          prompt: request.data,
          // A retry here would hide "unavailable" for seconds, and could repeat text already handed over.
          maxRetries: 0,
          abortSignal: controller.signal,
          // Failures arrive as stream parts and are read below. The SDK's default would print them,
          // and an SDK error can quote the request (D163).
          onError: () => undefined,
          ...callSettings(request.maxOutputTokens),
        });
        for await (const part of result.stream) {
          if (cut !== undefined) break;
          if (part.type === 'text-delta') {
            // Answer text only: the middleware has already turned any thinking into reasoning parts.
            if (part.text === '') continue;
            if (firstTextMs === undefined) firstTextMs = since(startedAt);
            text += part.text;
            pieces += 1;
            try {
              await request.onText(part.text);
            } catch (error) {
              readerFailed = { error };
              break;
            }
          } else if (part.type === 'finish') {
            finishReason = part.finishReason;
            usage = part.totalUsage;
          } else if (part.type === 'error') {
            failed = { error: part.error };
            break;
          }
          // Every other part, reasoning included, is never handed over, kept or logged (D243).
        }
        completed = cut === undefined && readerFailed === undefined && failed === undefined;
      }
    } catch (error) {
      // The stream itself broke (the connection dropped mid-answer). A cut-short stream can also
      // end this way; then the cut is what counts.
      if (cut === undefined && readerFailed === undefined && failed === undefined) failed = { error };
    } finally {
      clearTimeout(timer);
      for (const stop of stops) stop.removeEventListener('abort', onStop);
      // Whatever stopped the reading early also stops the server writing.
      if (!completed) controller.abort();
    }

    const elapsedMs = since(startedAt);
    if (readerFailed !== undefined) {
      this.log.warn(
        { model, errorType: errorTypeOf(readerFailed.error), elapsedMs, waitedMs, pieces },
        'text model stream stopped: its reader failed',
      );
      throw readerFailed.error;
    }

    let ending: TextStreamEnding;
    if (cut === 'stopped') {
      ending = 'stopped';
    } else if (cut === 'time_limit') {
      if (pieces === 0) {
        const failure = new AiFailure('timed_out', { model, elapsedMs });
        this.log.warn({ model, code: failure.code, elapsedMs, waitedMs }, 'text model stream failed');
        throw failure;
      }
      ending = 'time_limit';
    } else if (failed !== undefined || finishReason === undefined || finishReason === 'error') {
      // No finish from the server means the answer is incomplete for a reason nobody chose (fail safe).
      const refused = failed === undefined ? undefined : refusedKeyStatus(failed.error);
      let failure: AiFailure | AiCallError;
      if (failed === undefined) failure = new AiFailure('unavailable', { model, elapsedMs });
      else if (refused !== undefined) failure = new AiFailure('unavailable', { model, elapsedMs, httpStatus: refused });
      else failure = streamFailure(failed.error, { model, elapsedMs });
      this.logFailure(failure, { elapsedMs, waitedMs, pieces }, 'text model stream failed');
      throw failure;
    } else if (pieces === 0) {
      // Finished, or cut by the token cap (thinking can use it all up), with no answer text: a
      // failure, never an empty answer.
      const failure = new AiFailure('unavailable', { model, elapsedMs });
      this.log.warn({ model, code: failure.code, elapsedMs, waitedMs, pieces: 0 }, 'text model stream failed');
      throw failure;
    } else {
      ending = finishReason === 'length' ? 'token_cap' : 'finished';
    }

    const answer: TextStreamAnswer = { text, ending, model, waitedMs, elapsedMs, pieces };
    if (firstTextMs !== undefined) answer.firstTextMs = firstTextMs;
    if (usage?.inputTokens !== undefined) answer.inputTokens = usage.inputTokens;
    if (usage?.outputTokens !== undefined) answer.outputTokens = usage.outputTokens;
    this.log.info(
      {
        model,
        ending,
        elapsedMs,
        waitedMs,
        firstTextMs,
        pieces,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
      },
      'text model streamed',
    );
    return answer;
  }
}
