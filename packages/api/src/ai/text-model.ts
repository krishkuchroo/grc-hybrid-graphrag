// The small text-model interface (D8, D45.2): fixed instructions, data and a Zod schema in; an
// answer that passes the schema out, or a typed `AiFailure` (`unavailable`, `timed_out`,
// `invalid_output`). A test or another model can stand in for it behind the TEXT_MODEL token.
import type { z } from 'zod';

export const TEXT_MODEL = Symbol('TextModel');

export interface TextRequest<T> {
  /** The fixed instructions (the system part of the prompt). Never logged. */
  instructions: string;
  /**
   * The data the instructions work on (the user part of the prompt). A caller sending document
   * text puts it inside `<UNSTRUCTURED_DOCUMENT_CONTEXT>` (D52.3). Never logged.
   */
  data: string;
  /** The answer must pass this schema; its parsed output is what the call returns. */
  schema: z.ZodType<T>;
  /**
   * The shape the model is held to while it writes (Ollama's structured output). Defaults to
   * `schema`. A caller that reads the answer leniently passes its strict shape here and a lenient
   * `schema`, so the model is still guided by the strict one.
   */
  answerShape?: z.ZodType;
  /** Time limit for the model call itself, not counting the wait for its turn. */
  timeoutMs?: number;
  /** A cap on the tokens the model writes. */
  maxOutputTokens?: number;
}

export interface TextAnswer<T> {
  /** The answer, as parsed by the request's schema. */
  value: T;
  /** The model that answered, so callers can record it (D69). */
  model: string;
  /** Time the model call took, in milliseconds. */
  elapsedMs: number;
  /** Time spent waiting for the program's one model slot, in milliseconds. */
  waitedMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TextModel {
  /** The model this client asks, for example `gemma4:12b`. */
  readonly modelName: string;
  /**
   * Asks the model. At most one call runs at a time in the program; others wait their turn, in
   * the order they were made. Rejects with an `AiFailure` for the three typed failures.
   */
  generate<T>(request: TextRequest<T>): Promise<TextAnswer<T>>;
}
