// The text model on Ollama (D19, D31, D32, D34): gemma4:12b by default, temperature 0, a fixed
// seed and an 8,192-token context, the settings the size test ran with. The answer is held to the
// schema while Gemma writes (Ollama's structured output) and checked against it afterwards; an
// answer that fails is `invalid_output`, with no second try (D39: no double runs).
//
// `stream` (S6-002, D47) asks with the same settings and no schema, and hands the answer over in
// pieces as Gemma writes it, ending with a report: the times, the token counts and whether it
// finished or was cut short (token cap, time limit, or stopped by the caller).
//
// One call at a time per program (D34, D72): every client in the program shares one gate, so a
// second call waits for the first, in the order the calls were made. The time limit starts when
// the call's turn comes. A `turn` (S6-002, D48) holds that one slot for work that makes several
// calls (a chat question's graph query, then its answer): its session's calls don't queue again,
// while everything else waits in order and can be told its place.
//
// Logs (D163): the model, timings, token counts and failure codes only. Never the instructions,
// the data, the answer or the SDK's errors.
import {
  generateText,
  jsonSchema,
  Output,
  streamText,
  zodSchema,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type Schema,
} from 'ai';
import type { Logger } from 'pino';
import { createLogger } from '../common/logger.js';
import { AiFailure, AiInputError, AiStopped, toAiError, type AiCallError } from './ai-failure.js';
import type { AiSettings } from './ai-settings.js';
import { createOllamaProvider, type FetchLike } from './ollama-provider.js';
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

export const TEXT_MODEL_TEMPERATURE = 0;
/** A fixed seed, so the same prompt gives the same answer (D45.8). */
export const TEXT_MODEL_SEED = 42;
export const TEXT_MODEL_CONTEXT_TOKENS = 8192;
/** About 37 s a chunk when warm (D34), plus loading the model on a cold start. */
export const TEXT_MODEL_TIMEOUT_MS = 300_000;

/** The program's one Gemma slot, shared by every text model client in this program. */
export const PROGRAM_GATE = new SerialGate();

export interface OllamaTextModelOptions {
  settings: Pick<AiSettings, 'ollamaBaseUrl' | 'textModel'>;
  log?: Logger;
  /** Stands in for the network, for tests. */
  fetch?: FetchLike;
  /** The time limit of a call that sets none. */
  timeoutMs?: number;
  /** For tests: a gate of their own instead of the program's. */
  gate?: SerialGate;
}

export function positiveWhole(value: number | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new AiInputError(`${what} must be a whole number from 1`);
  return value;
}

export function checkRequest<T>(request: TextRequest<T>): void {
  if (typeof request.instructions !== 'string' || request.instructions.trim() === '') {
    throw new AiInputError('The instructions are empty.');
  }
  if (typeof request.data !== 'string') throw new AiInputError('The data must be text.');
  positiveWhole(request.timeoutMs, 'timeoutMs');
  positiveWhole(request.maxOutputTokens, 'maxOutputTokens');
}

export function checkSignal(signal: unknown): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new AiInputError('The signal must be an AbortSignal.');
  }
}

export function checkStreamRequest(request: TextStreamRequest): void {
  if (typeof request !== 'object' || request === null) throw new AiInputError('The request is missing.');
  if (typeof request.instructions !== 'string' || request.instructions.trim() === '') {
    throw new AiInputError('The instructions are empty.');
  }
  if (typeof request.data !== 'string') throw new AiInputError('The data must be text.');
  if (positiveWhole(request.maxOutputTokens, 'maxOutputTokens') === undefined) {
    throw new AiInputError('A stream needs maxOutputTokens.');
  }
  if (positiveWhole(request.timeoutMs, 'timeoutMs') === undefined) throw new AiInputError('A stream needs timeoutMs.');
  if (typeof request.onText !== 'function') throw new AiInputError('A stream needs onText.');
  checkSignal(request.signal);
}

/** The shape sent to Ollama (answerShape, else schema), checked against the request's schema. */
export function checkedSchema<T>(request: TextRequest<T>): Schema<T> {
  const shape = zodSchema(request.answerShape ?? request.schema);
  return jsonSchema<T>(() => shape.jsonSchema, {
    validate: async (value) => {
      const parsed = await request.schema.safeParseAsync(value);
      // The SDK's own error would carry the value; this one carries nothing.
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: new Error('The answer did not pass the schema.') };
    },
  });
}

/** Ollama's own options for every call: the size test's settings (D32, D34, D45.8). */
function ollamaProviderOptions(maxOutputTokens: number | undefined) {
  return {
    ollama: {
      options: {
        temperature: TEXT_MODEL_TEMPERATURE,
        seed: TEXT_MODEL_SEED,
        num_ctx: TEXT_MODEL_CONTEXT_TOKENS,
        ...(maxOutputTokens === undefined ? {} : { num_predict: maxOutputTokens }),
      },
    },
  };
}

export function since(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * What a stream's failure means. A stream has no schema, so an answer Ollama garbled is Ollama
 * misbehaving (`unavailable`), not a refused answer; and Ollama reports a failure mid-answer as a
 * bare error line, which is the same.
 */
export function streamFailure(err: unknown, ctx: { model: string; elapsedMs: number }): AiFailure | AiCallError {
  if (typeof err === 'string') return new AiFailure('unavailable', ctx);
  const failure = toAiError(err, { ...ctx, timedOut: false });
  if (failure instanceof AiFailure && failure.code === 'invalid_output') return new AiFailure('unavailable', ctx);
  return failure;
}

export function errorTypeOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

export class OllamaTextModel implements TextModel {
  readonly modelName: string;
  private readonly model: LanguageModel;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly gate: SerialGate;

  constructor(opts: OllamaTextModelOptions) {
    this.modelName = opts.settings.textModel;
    this.model = createOllamaProvider({ baseUrl: opts.settings.ollamaBaseUrl, fetch: opts.fetch }).chat(this.modelName);
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
        output: Output.object({ schema: checkedSchema(request) }),
        // The job queue retries (D72); a retry here would hide "unavailable" for seconds.
        maxRetries: 0,
        abortSignal: controller.signal,
        providerOptions: ollamaProviderOptions(request.maxOutputTokens),
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
      const failure = toAiError(err, { model, elapsedMs, timedOut: cut === 'timed_out' });
      if (failure instanceof AiFailure) {
        this.log.warn(
          { model, code: failure.code, elapsedMs, waitedMs, httpStatus: failure.httpStatus },
          'text model call failed',
        );
      } else {
        this.log.error(
          { model, errorType: failure.errorType, elapsedMs, waitedMs, httpStatus: failure.httpStatus },
          'text model call failed',
        );
      }
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
          providerOptions: ollamaProviderOptions(request.maxOutputTokens),
        });
        for await (const part of result.stream) {
          if (cut !== undefined) break;
          if (part.type === 'text-delta') {
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
      // Whatever stopped the reading early also stops Ollama writing.
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
      // No finish from Ollama means the answer is incomplete for a reason nobody chose (fail safe).
      const failure =
        failed === undefined
          ? new AiFailure('unavailable', { model, elapsedMs })
          : streamFailure(failed.error, { model, elapsedMs });
      if (failure instanceof AiFailure) {
        this.log.warn(
          { model, code: failure.code, elapsedMs, waitedMs, pieces, httpStatus: failure.httpStatus },
          'text model stream failed',
        );
      } else {
        this.log.error(
          { model, errorType: failure.errorType, elapsedMs, waitedMs, pieces, httpStatus: failure.httpStatus },
          'text model stream failed',
        );
      }
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
