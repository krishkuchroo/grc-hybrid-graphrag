// 20 uploads a minute per person (D64), counting `POST /api/v1/uploads` and `POST /api/v1/evidence`
// together (S3 shared notes, "Upload safety"). A second `RateLimiter` next to the API's 300 a
// minute, in API memory like it (D64). It runs on `onRequest`, before the body is read, so the
// 21st upload in a minute is 429 `rate_limited` "try again in N s" without reading its file.
// A person is the signed-in user (`personKey`); a machine is its API key, keyed on a hash of the
// credential (never the credential itself), so two keys behind the same address don't share a count.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from '../../common/errors.js';
import { RateLimiter, personKey } from '../../common/rate-limit.js';
import { bearerOf } from '../../identity/api-key.guard.js';
import { isMultipartRoute } from './multipart.js';

export const UPLOAD_RATE_PER_MINUTE = 20;

/** The upload limiter's key: the API key's credential hash for a machine, else `personKey`. */
export function uploadRateKey(request: FastifyRequest): string {
  const credential = bearerOf(request);
  if (credential !== null) return `api_key:${createHash('sha256').update(credential).digest('hex')}`;
  return personKey(request);
}

/** The upload routes' own limit, on top of the API-wide one. */
export function registerUploadRateLimit(
  fastify: FastifyInstance,
  limiter: RateLimiter = new RateLimiter(UPLOAD_RATE_PER_MINUTE),
  keyOf: (request: FastifyRequest) => string = uploadRateKey,
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isMultipartRoute(request)) return;
    const decision = limiter.hit(keyOf(request));
    if (decision.allowed) return;
    const seconds = decision.retryAfterSeconds;
    sendError(request, reply, 429, 'rate_limited', `Too many uploads, try again in ${seconds} s.`, {
      'retry-after': String(seconds),
    });
    return reply;
  });
}
