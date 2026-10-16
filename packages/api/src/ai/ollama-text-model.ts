// The text model on Ollama (D19, D31, D32, D34): gemma4:12b by default, temperature 0, a fixed
// seed and an 8,192-token context, the settings the size test ran with. The answer is held to the
// schema while Gemma writes (Ollama's structured output) and checked against it afterwards; an
// answer that fails is `invalid_output`, with no second try (D39: no double runs).
//
// One call at a time per program (D34, D72): every client in the program shares one gate, so a
// second call waits for the first, in the order the calls were made. The time limit starts when
// the call's turn comes.
//
// Logs (D163): the model, timings, token counts and failure codes only. Never the instructions,
// the data, the answer or the SDK's errors.
import { generateText, jsonSchema, Output, zodSchema, type LanguageModel, type Schema } from 'ai';
import type { Logger } from 'pino';
import { createLogger } from '../common/logger.js';
import { AiFailure, AiInputError, toAiError } from './ai-failure.js';
import type { AiSettings } from './ai-settings.js';
import { createOllamaProvider, type FetchLike } from './ollama-provider.js';
import { SerialGate } from './serial-gate.js';
import type { TextAnswer, TextModel, TextRequest } from './text-model.js';

export const TEXT_MODEL_TEMPERATURE = 0;
/** A fixed seed, so the same prompt gives the same answer (D45.8). */
export const TEXT_MODEL_SEED = 42;
export const TEXT_MODEL_CONTEXT_TOKENS = 8192;
/** About 37 s a chunk when warm (D34), plus loading the model on a cold start. */
export const TEXT_MODEL_TIMEOUT_MS = 300_000;

/** The program's one Gemma slot, shared by every text model client in this program. */
const PROGRAM_GATE = new SerialGate();

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

function positiveWhole(value: number | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new AiInputError(`${what} must be a whole number from 1`);
  return value;
}

function checkRequest<T>(request: TextRequest<T>): void {
  if (typeof request.instructions !== 'string' || request.instructions.trim() === '') {
    throw new AiInputError('The instructions are empty.');
  }
  if (typeof request.data !== 'string') throw new AiInputError('The data must be text.');
  positiveWhole(request.timeoutMs, 'timeoutMs');
  positiveWhole(request.maxOutputTokens, 'maxOutputTokens');
}

/** The shape sent to Ollama (answerShape, else schema), checked against the request's schema. */
function checkedSchema<T>(request: TextRequest<T>): Schema<T> {
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
    return this.gate.run(() => this.call(request, Math.round(performance.now() - queuedAt)));
  }

  private async call<T>(request: TextRequest<T>, waitedMs: number): Promise<TextAnswer<T>> {
    const model = this.modelName;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
        providerOptions: {
          ollama: {
            options: {
              temperature: TEXT_MODEL_TEMPERATURE,
              seed: TEXT_MODEL_SEED,
              num_ctx: TEXT_MODEL_CONTEXT_TOKENS,
              ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
            },
          },
        },
      });
      const value = result.output;
      const elapsedMs = Math.round(performance.now() - startedAt);
      const answer: TextAnswer<T> = { value, model, elapsedMs, waitedMs };
      if (result.usage.inputTokens !== undefined) answer.inputTokens = result.usage.inputTokens;
      if (result.usage.outputTokens !== undefined) answer.outputTokens = result.usage.outputTokens;
      this.log.info(
        { model, elapsedMs, waitedMs, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
        'text model answered',
      );
      return answer;
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      const failure = toAiError(err, { model, elapsedMs, timedOut });
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
    }
  }
}
