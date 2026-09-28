// One error format, with a reference ID (D47):
//   { "error": { "code": string, "message": string, "referenceId": string } }
// Used for every error, including 404s, validation errors and unexpected errors. The reference ID
// also goes into the pino log line. For an unexpected error the log holds only its type or code,
// never its message or stack (SF-006, D163, D164).
import { randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

export interface ErrorBody {
  error: { code: string; message: string; referenceId: string };
}

export const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  500: 'internal_error',
  503: 'unavailable',
};

const UNEXPECTED_MESSAGE = 'Something went wrong. Quote the reference ID if you report it.';

export function newReferenceId(): string {
  return randomUUID();
}

export function errorBody(code: string, message: string, referenceId = newReferenceId()): ErrorBody {
  return { error: { code, message, referenceId } };
}

/** Sends an error in the one format, and logs its reference ID. For errors raised outside Nest's
 * handlers (Fastify hooks). */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): ErrorBody {
  const body = errorBody(code, message);
  const where = { referenceId: body.error.referenceId, status, method: request.method, url: request.url };
  request.log.warn({ ...where, code, detail: message }, 'request refused');
  void reply
    .code(status)
    .headers(headers)
    .header('content-type', 'application/json; charset=utf-8')
    .send(JSON.stringify(body));
  return body;
}

/** Keeps the connection open after the 413 for a body over the 1 MB cap (TEST-006, D188).
 * Fastify marks that answer `Connection: close` and doesn't read the body, so Node would close the
 * socket with the body still arriving and reset it; Caddy then sees the write error before the 413
 * and answers 502. Without the header, Node reads the rest of the body and throws it away. The door
 * caps it at 25 MB (D53), so that read is bounded. Other body errors still close the connection. */
export function registerBodyTooLargeKeepAlive(fastify: FastifyInstance): void {
  fastify.addHook('onError', async (_request, reply, error) => {
    if ((error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') reply.removeHeader('connection');
  });
}

/** An HTTP error with its own code in the one format, for example 403 `mfa_required`. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(message, status);
  }
}

interface Described {
  status: number;
  code: string;
  message: string;
}

function httpMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string' && message) return message;
  return exception.message;
}

function describe(exception: unknown): Described {
  if (exception instanceof ZodError) {
    const message = exception.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    return { status: 400, code: 'validation_failed', message: message || 'The input is not valid.' };
  }
  if (exception instanceof ApiError && exception.getStatus() < 500) {
    return { status: exception.getStatus(), code: exception.code, message: exception.message };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status >= 500) return { status, code: CODES[status] ?? 'internal_error', message: UNEXPECTED_MESSAGE };
    return { status, code: CODES[status] ?? 'error', message: httpMessage(exception) || 'The request was refused.' };
  }
  return { status: 500, code: 'internal_error', message: UNEXPECTED_MESSAGE };
}

/** What an unexpected error's log line may hold: its type and code, never its message or stack,
 * which can quote record or audit values (SF-006, D163, D164). */
export function errorKind(err: unknown): { errorType?: string; errorCode?: string } {
  if (typeof err !== 'object' || err === null) return { errorType: typeof err };
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  const fields: { errorType?: string; errorCode?: string } = {};
  const type = typeof e.name === 'string' && e.name !== 'Error' ? e.name : e.constructor?.name;
  if (typeof type === 'string' && type !== '') fields.errorType = type;
  if (typeof e.code === 'string' || typeof e.code === 'number') fields.errorCode = String(e.code);
  return fields;
}

/** The global filter: every error Nest sees leaves in the one format. An unexpected error is
 * logged with its type or code, the reference ID, the method and the URL only. */
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const { status, code, message } = describe(exception);
    const body = errorBody(code, message);
    const where = { referenceId: body.error.referenceId, status, method: request.method, url: request.url };
    if (status >= 500) {
      this.log.error({ ...where, ...errorKind(exception) }, 'unexpected error');
    } else {
      this.log.warn({ ...where, code, detail: message }, 'request refused');
    }
    void reply.code(status).header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(body));
  }
}
