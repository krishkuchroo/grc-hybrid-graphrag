// 60 push batches a minute per API key (D64), on `POST /api/v1/push/batches` only. A third
// `RateLimiter` next to the API's 300 a minute and the uploads' 20, in API memory like them (D64).
// It runs on `onRequest`, before the body is read, so the 61st batch in a minute is 429
// `rate_limited` "try again in N s" without reading its rows. The key is a hash of the API key's
// credential (never the credential itself), so two keys never share a count; a request without a
// key (a signed-in person, refused 403 `api_key_required` later) is counted per person.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from '../../common/errors.js';
import { RateLimiter } from '../../common/rate-limit.js';
import { uploadRateKey } from '../uploads/upload-rate-limit.js';

export const PUSH_RATE_PER_MINUTE = 60;

/** The push route, as Fastify matched it (full path). */
export const PUSH_BATCHES_ROUTE = { method: 'POST', path: '/api/v1/push/batches' } as const;

/** Whether the request matched the push route. */
export function isPushRoute(request: FastifyRequest): boolean {
  return request.method === PUSH_BATCHES_ROUTE.method && request.routeOptions.url === PUSH_BATCHES_ROUTE.path;
}

/** The push limiter's key: the API key's credential hash, else the person. */
export function pushRateKey(request: FastifyRequest): string {
  return uploadRateKey(request);
}

/** The push route's own limit, on top of the API-wide one. */
export function registerPushRateLimit(
  fastify: FastifyInstance,
  limiter: RateLimiter = new RateLimiter(PUSH_RATE_PER_MINUTE),
  keyOf: (request: FastifyRequest) => string = pushRateKey,
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isPushRoute(request)) return;
    const decision = limiter.hit(keyOf(request));
    if (decision.allowed) return;
    const seconds = decision.retryAfterSeconds;
    sendError(request, reply, 429, 'rate_limited', `Too many push batches, try again in ${seconds} s.`, {
      'retry-after': String(seconds),
    });
    return reply;
  });
}
