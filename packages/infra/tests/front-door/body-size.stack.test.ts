// M0-016 criterion 5 (D53, D64): uploads over 25 MB are refused at the door; other requests over
// 1 MB are refused by the API (M0-007).
//
// "At the door" means the API never sees the request. The tests check that in grc-api's own log:
// Fastify logs every incoming request with its URL, so each request carries a fresh marker in its
// query string, and the test looks for the marker in `docker logs grc-api`. A control request that
// must reach the API proves the log check itself works, so a quiet log can't pass as "refused".
//
// 25 MB and 1 MB are binary megabytes, the same unit as the API's BODY_LIMIT_BYTES (1_048_576).
// A body of exactly 25 MB is let through to the API (which then applies its own 1 MB cap).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_CAP_BYTES, MB, UPLOAD_CAP_BYTES, apiLogged, apiLogsSince, errorBody, https } from './helpers.js';

const UPLOAD = '/api/v1/intake/uploads';

function upload(marker: string, bytes: number) {
  return https(`${UPLOAD}?probe=${marker}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    bodyBytes: bytes,
    timeoutMs: 90_000,
  });
}

describe('criterion 5: 25 MB at the door, 1 MB at the API', () => {
  it('control: a 2 MB upload passes the door and reaches the API (its marker is in the API log)', async () => {
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    await upload(marker, 2 * MB);
    expect(await apiLogged(marker, since)).toBe(true);
  });

  it('an upload of exactly 25 MB passes the door and reaches the API', async () => {
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    await upload(marker, UPLOAD_CAP_BYTES);
    expect(await apiLogged(marker, since)).toBe(true);
  });

  it('an upload of 25 MB + 1 byte gets 413 from the door, and the API never sees it', async () => {
    const control = randomUUID();
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    const res = await upload(marker, UPLOAD_CAP_BYTES + 1);
    expect(res.status).toBe(413);
    // A later request that does reach the API proves the log is being read up to now.
    await upload(control, 2 * MB);
    expect(await apiLogged(control, since)).toBe(true);
    expect(apiLogsSince(since).includes(marker)).toBe(false);
  });

  it('a 40 MB upload gets 413 from the door, and the API never sees it', async () => {
    const control = randomUUID();
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    const res = await upload(marker, 40 * MB);
    expect(res.status).toBe(413);
    await upload(control, 2 * MB);
    expect(await apiLogged(control, since)).toBe(true);
    expect(apiLogsSince(since).includes(marker)).toBe(false);
  });

  it('a JSON request just over 1 MB passes the door and is refused by the API with 413 in its error format', async () => {
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    const res = await https(`/api/v1/auth/sign-in/email?probe=${marker}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyBytes: API_CAP_BYTES + 1_024,
    });
    expect(res.status).toBe(413);
    expect(errorBody(res)?.code).toBe('payload_too_large');
    expect(await apiLogged(marker, since)).toBe(true);
  });

  it('a small JSON request still goes through the door to the API', async () => {
    const res = await https('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@front-door.example', password: 'not-a-real-password-1' }),
    });
    expect(res.status).not.toBe(413);
    expect(errorBody(res)).toBeDefined();
  });
});
