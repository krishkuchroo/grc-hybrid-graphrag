// TEST-006 (D187, D188): a request just over the API's 1 MB cap must always get the API's 413, never
// the door's 502 (D53, D64, D47).
//
// The cause, from the code:
// - The API refuses a body whose declared size is over BODY_LIMIT_BYTES without reading it, and
//   Fastify marks that answer `Connection: close` (fastify/lib/content-type-parser.js, rawBody and
//   onDone). Node then closes the socket with the unread body still arriving, which resets the
//   connection.
// - Caddy is still forwarding the body when that reset lands. Go's HTTP client (Caddy 2.11.4, Go
//   1.26.3, net/http/transport.go persistConn.roundTrip) returns the write error as soon as it sees
//   it, even when the API's 413 is already in the socket, so Caddy answers 502 Bad Gateway
//   (Caddyfile handle_errors: `front_door_error`). Which of the two Caddy sees first is down to Go's
//   scheduling: in TEST-006's runs 39 of 250 such requests (about 1 in 6) got 502, at any size from
//   1 MB to 20 MB, one at a time or ten at once.
//
// One request can't show that every time, so this test sends REQUESTS of them, one after another,
// and every one must be the API's 413. Even at 1 in 9, all of them pass by luck less than once in
// 1,000 runs (0.89^60 ≈ 0.0009). Once the API no longer resets a connection it has answered while
// the body is still arriving, none of them can get 502.
//
// Each request carries a marker in its query string, and every marker must be in the API's log, so
// a 413 from the door (a 1 MB cap moved into Caddy) can't pass as the API's (D64: the 1 MB cap is
// the API's). The requests stay far below the 300 a minute rate limit with the rest of the stack
// tests (D64).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_CAP_BYTES, apiLogged, apiLogsSince, errorBody, headerCount, https } from './helpers.js';

const REQUESTS = 60;
// 60 requests of 1 MB take a few seconds; the limit only stops a hung run.
const TEST_TIMEOUT_MS = 120_000;

describe('TEST-006: a JSON body just over 1 MB always gets the API 413, never a 502', () => {
  it(
    `${REQUESTS} JSON requests just over 1 MB, one after another, all get 413 payload_too_large from the API`,
    async () => {
      const since = new Date(Date.now() - 1_000);
      const markers: string[] = [];
      const statuses: Record<string, number> = {};
      const problems: string[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const marker = randomUUID();
        markers.push(marker);
        const res = await https(`/api/v1/auth/sign-in/email?probe=${marker}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          bodyBytes: API_CAP_BYTES + 1_024,
        });
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status !== 413) {
          problems.push(`request ${i + 1}: ${res.status} ${res.text.slice(0, 200)}`);
          continue;
        }
        // D47: the one error format, with a reference ID.
        const err = errorBody(res);
        if (err?.code !== 'payload_too_large' || !err.referenceId) {
          problems.push(`request ${i + 1}: 413 not in the D47 format: ${res.text.slice(0, 200)}`);
        }
        // D64: the security headers, each sent once.
        for (const name of [
          'strict-transport-security',
          'x-frame-options',
          'x-content-type-options',
          'content-security-policy',
        ]) {
          if (headerCount(res, name) !== 1) {
            problems.push(`request ${i + 1}: ${name} sent ${headerCount(res, name)} times`);
          }
        }
      }
      expect(statuses, problems.join('\n')).toEqual({ 413: REQUESTS });
      expect(problems).toEqual([]);

      // Every request reached the API: its 413 is the API's own 1 MB cap, not the door's.
      expect(await apiLogged(markers[markers.length - 1]!, since)).toBe(true);
      const log = apiLogsSince(since);
      expect(markers.filter((m) => !log.includes(m))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
