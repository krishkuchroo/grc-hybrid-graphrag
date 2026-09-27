// Security headers on every response (D64): no framing, HTTPS only, strict content rules.
// The API serves JSON only, so its content policy allows nothing to load.
import type { FastifyInstance } from 'fastify';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    void reply.headers(SECURITY_HEADERS);
    return payload;
  });
}
