// The typed failures of the AI clients (D45.7, D163). A failure says what went wrong in a code, the
// model, the time taken and, for an HTTP answer, its status: never the prompt, the data, the
// model's answer or a vector, and never the library's own error (its message, properties and cause
// can quote the request body or the model's output).
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  RetryError,
  TypeValidationError,
} from 'ai';

/**
 * - `unavailable`: Ollama can't be reached, the model isn't there, or Ollama couldn't serve the
 *   call (busy, out of memory). Waiting and trying again later is the answer (D45.7).
 * - `timed_out`: the call took longer than its time limit.
 * - `invalid_output`: no answer passes the schema (text model), or a vector has the wrong size or
 *   count (embedder).
 */
export const AI_FAILURE_CODES = ['unavailable', 'timed_out', 'invalid_output'] as const;
export type AiFailureCode = (typeof AI_FAILURE_CODES)[number];

const MESSAGES: Record<AiFailureCode, string> = {
  unavailable: 'The model service is unavailable.',
  timed_out: 'The model call timed out.',
  invalid_output: "The model's answer did not pass the checks.",
};

/** A typed failure of a text model or embedder call. */
export class AiFailure extends Error {
  readonly code: AiFailureCode;
  /** The model asked, so callers can record it (D69). */
  readonly model: string;
  /** Time spent on the call itself, in milliseconds. */
  readonly elapsedMs: number;
  /** The HTTP status Ollama answered with, when it answered. */
  readonly httpStatus?: number;

  constructor(code: AiFailureCode, details: { model: string; elapsedMs: number; httpStatus?: number }) {
    super(`${MESSAGES[code]} (model ${details.model})`);
    this.name = 'AiFailure';
    this.code = code;
    this.model = details.model;
    this.elapsedMs = details.elapsedMs;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

export function isAiFailure(err: unknown, code?: AiFailureCode): err is AiFailure {
  return err instanceof AiFailure && (code === undefined || err.code === code);
}

/** The caller's input can't be sent (for example an empty text to embed). Names positions only. */
export class AiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiInputError';
  }
}

/**
 * Any other error of an AI call: a bug or a request Ollama refused (HTTP 400). It carries the
 * error's type and HTTP status only, so D72's retries apply and nothing of the call leaks.
 */
export class AiCallError extends Error {
  readonly errorType: string;
  readonly httpStatus?: number;

  constructor(details: { errorType: string; httpStatus?: number }) {
    super(
      `The AI call failed (${details.errorType}${details.httpStatus === undefined ? '' : `, HTTP ${details.httpStatus}`}).`,
    );
    this.name = 'AiCallError';
    this.errorType = details.errorType;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

/** HTTP statuses that mean "Ollama can't serve this now": the model is missing, busy or failing. */
function statusMeansUnavailable(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function errorType(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && name !== '' && name !== 'Error') return name;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === 'string' && ctor !== '' ? ctor : 'Error';
}

/**
 * Turns whatever an AI SDK call threw into an `AiFailure` or an `AiCallError`, keeping nothing of
 * the original error. `timedOut` is true when the call's own time limit fired.
 */
export function toAiError(
  err: unknown,
  ctx: { model: string; elapsedMs: number; timedOut: boolean },
): AiFailure | AiCallError {
  const details = { model: ctx.model, elapsedMs: ctx.elapsedMs };
  if (ctx.timedOut) return new AiFailure('timed_out', details);
  // With retries off the SDK throws the error itself, but a RetryError still names its last one.
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  if (
    NoObjectGeneratedError.isInstance(cause) ||
    NoOutputGeneratedError.isInstance(cause) ||
    NoContentGeneratedError.isInstance(cause) ||
    JSONParseError.isInstance(cause) ||
    TypeValidationError.isInstance(cause)
  ) {
    return new AiFailure('invalid_output', details);
  }
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    // No status: Ollama never answered (connection refused, host unknown, connection dropped).
    if (status === undefined) return new AiFailure('unavailable', details);
    if (statusMeansUnavailable(status)) return new AiFailure('unavailable', { ...details, httpStatus: status });
    // A 2xx whose body the provider couldn't read is Ollama misbehaving, not our request.
    if (status >= 200 && status < 300) return new AiFailure('unavailable', { ...details, httpStatus: status });
    return new AiCallError({ errorType: errorType(cause), httpStatus: status });
  }
  if (
    EmptyResponseBodyError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    NoSuchModelError.isInstance(cause)
  ) {
    return new AiFailure('unavailable', details);
  }
  // Node's fetch when the provider didn't wrap it: the connection itself failed.
  if (cause instanceof TypeError && /fetch failed/i.test(cause.message)) {
    return new AiFailure('unavailable', details);
  }
  return new AiCallError({ errorType: errorType(cause) });
}
