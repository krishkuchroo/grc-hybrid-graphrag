// 10 questions a minute per person (D64), counting asking (`POST /api/v1/chat/conversations/:id/
// messages`) and searching (`POST /api/v1/search`) together (planner's reading S6-Q10). A fourth
// `RateLimiter` next to the API's 300 a minute, the uploads' 20 and the push API's 60, in API memory
// like them (D64). It runs on `onRequest`, before the body is read, so the 11th in a minute is 429
// `rate_limited` "try again in N s", with `retry-after`, before anything is asked of Gemma.
// A person is the signed-in user; a machine is its API key, keyed on a hash of the credential (never
// the credential itself), so two keys never share a count (`uploadRateKey`).
import { rateLimitedText } from '@grc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from '../common/errors.js';
import { RateLimiter } from '../common/rate-limit.js';
import { uploadRateKey } from '../intake/uploads/upload-rate-limit.js';

export const CHAT_RATE_PER_MINUTE = 10;

/** The routes the chat limit counts together (full paths, as Fastify matched them). */
export const CHAT_RATE_ROUTES: readonly { method: 'POST'; path: string }[] = [
  { method: 'POST', path: '/api/v1/chat/conversations/:id/messages' },
  { method: 'POST', path: '/api/v1/search' },
];

/** Whether the request matched one of the counted routes. */
export function isChatRateRoute(request: FastifyRequest): boolean {
  const path = request.routeOptions.url;
  return path !== undefined && CHAT_RATE_ROUTES.some((r) => r.method === request.method && r.path === path);
}

/** The chat limiter's key: the API key's credential hash for a machine, else the person. */
export function chatRateKey(request: FastifyRequest): string {
  return uploadRateKey(request);
}

/** Asking and searching's own limit, on top of the API-wide one. */
export function registerChatRateLimit(
  fastify: FastifyInstance,
  limiter: RateLimiter = new RateLimiter(CHAT_RATE_PER_MINUTE),
  keyOf: (request: FastifyRequest) => string = chatRateKey,
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isChatRateRoute(request)) return;
    const decision = limiter.hit(keyOf(request));
    if (decision.allowed) return;
    const seconds = decision.retryAfterSeconds;
    sendError(request, reply, 429, 'rate_limited', rateLimitedText(seconds), { 'retry-after': String(seconds) });
    return reply;
  });
}
