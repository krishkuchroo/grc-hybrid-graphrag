// The small text-model interface (D8, D45.2): fixed instructions, data and a Zod schema in; an
// answer that passes the schema out, or a typed `AiFailure` (`unavailable`, `timed_out`,
// `invalid_output`). A test or another model can stand in for it behind the TEXT_MODEL token.
//
// S6-002 adds `stream` (the answer handed over in pieces as the model writes it, D47) and `turn`
// (the program's one model slot held for a piece of work that makes several calls, while others
// wait in order and are told their place, D48).
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

export interface TextStreamRequest {
  /** The fixed instructions (the system part of the prompt). Never logged. */
  instructions: string;
  /**
   * The data the instructions work on (the user part of the prompt). Document text sits inside
   * `<UNSTRUCTURED_DOCUMENT_CONTEXT>` (D52.3). Never logged.
   */
  data: string;
  /** A cap on the tokens the model writes. Reaching it ends the answer as `token_cap`. */
  maxOutputTokens: number;
  /**
   * Time limit for the model call itself, not counting the wait for its turn. Reached before any
   * text: the call fails `timed_out`. Reached mid-answer: it ends as `time_limit`, keeping what
   * was written.
   */
  timeoutMs: number;
  /**
   * Handed each piece of the answer, in order, as the model writes it. A promise it returns is
   * awaited before the next piece. If it throws, the call to the model is cancelled and the stream
   * rejects with that error. Not called once the stream has been stopped or has run out of time.
   */
  onText: (text: string) => void | Promise<void>;
  /**
   * Stops the stream: the call to the model is cancelled and the slot is free at once. Aborted
   * while waiting for the slot, the stream rejects with `AiStopped` and never runs; aborted while
   * running, it ends as `stopped`, keeping what was written.
   */
  signal?: AbortSignal;
}

/**
 * How a stream ended: `finished` (the model ended its answer), or cut short by `token_cap` (the
 * request's cap), `time_limit` (the request's time limit, after some text) or `stopped` (the
 * caller's signal).
 */
export const TEXT_STREAM_ENDINGS = ['finished', 'token_cap', 'time_limit', 'stopped'] as const;
export type TextStreamEnding = (typeof TEXT_STREAM_ENDINGS)[number];

export interface TextStreamAnswer {
  /** Everything handed over, the pieces joined in order. */
  text: string;
  ending: TextStreamEnding;
  /** The model that answered, so callers can record it (D69). */
  model: string;
  /** Time spent waiting for the program's one model slot, in milliseconds. */
  waitedMs: number;
  /** From the call's start to the first piece, in milliseconds; absent when nothing was written. */
  firstTextMs?: number;
  /** Time the model call took, start to end, in milliseconds (waiting not counted). */
  elapsedMs: number;
  /** How many pieces were handed over. */
  pieces: number;
  /** Token counts, as the model reported them; absent when it reported none (a stopped call). */
  inputTokens?: number;
  outputTokens?: number;
}

/** The calls a text model answers, on the model itself or inside a turn. */
export interface TextModelCalls {
  /** The model this client asks, for example `gemma4:12b`. */
  readonly modelName: string;
  /**
   * Asks the model. At most one call runs at a time in the program; others wait their turn, in
   * the order they were made. Rejects with an `AiFailure` for the three typed failures.
   */
  generate<T>(request: TextRequest<T>): Promise<TextAnswer<T>>;
  /**
   * Asks the model with no schema and hands its answer over in pieces as it's written, with the
   * same settings as `generate` (temperature 0, the fixed seed, the 8,192-token context). Resolves
   * with the end report once the answer has finished or been cut short. Rejects with `AiFailure`
   * `unavailable` (the model can't be reached or is missing, it failed mid-answer, or it wrote
   * nothing) or
   * `timed_out` (no text within the time limit), or with `AiStopped` (stopped while waiting).
   */
  stream(request: TextStreamRequest): Promise<TextStreamAnswer>;
}

/**
 * The calls of one turn: they run in the turn's slot and never queue behind other work. Its calls
 * run one at a time, in the order made. Once the turn has ended, or its signal has aborted, they
 * refuse to run (`AiInputError` and `AiStopped`); the turn's signal also stops a call that is
 * running (`generate` rejects with `AiStopped`, `stream` ends as `stopped`).
 */
export interface TextModelSession extends TextModelCalls {
  /** How long the turn waited for the program's one model slot, in milliseconds. */
  readonly waitedMs: number;
}

export interface TurnOptions {
  /** Told the turn's place while it waits (1 means next), each time it changes. */
  onPosition?: (position: number) => unknown;
  /**
   * Aborted while waiting, the turn leaves the queue and rejects with `AiStopped` without running.
   * Aborted while running, it frees the slot at once and stops the session's calls; the turn still
   * settles with whatever its work returns or throws.
   */
  signal?: AbortSignal;
}

export interface TextModel extends TextModelCalls {
  /**
   * Reserves the program's one model slot for work that makes several calls (S6: writing the
   * graph query, then the answer), so no other call slips in between them. The work gets a
   * session whose `generate` and `stream` don't queue again. Calls on the model itself (outside
   * any turn) share the same queue, one call at a time. The turn ends when its work settles, and
   * always frees the slot, even if the work throws; it settles as the work did. The work must use
   * the session: a call on the model itself from inside the work would wait for its own turn.
   */
  turn<T>(work: (session: TextModelSession) => Promise<T>, options?: TurnOptions): Promise<T>;
}
