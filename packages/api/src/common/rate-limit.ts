// 300 requests a minute per person (D64). The counters live in API memory in v1 (D64).
// A person is the session user once login exists (M0-010), else the client IP.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

export const REQUESTS_PER_MINUTE = 300;

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** A fixed one-minute window per key. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count <= this.limit) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

export function personKey(request: FastifyRequest): string {
  const userId = (request as FastifyRequest & { user?: { id?: string } }).user?.id;
  return userId ? `user:${userId}` : `ip:${request.ip}`;
}

export function registerRateLimit(fastify: FastifyInstance, limiter: RateLimiter, keyOf = personKey): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const decision = limiter.hit(keyOf(request));
    if (decision.allowed) return;
    const seconds = decision.retryAfterSeconds;
    sendError(reply, 429, 'rate_limited', `Too many requests, try again in ${seconds} s.`, {
      'retry-after': String(seconds),
    });
    return reply;
  });
}
