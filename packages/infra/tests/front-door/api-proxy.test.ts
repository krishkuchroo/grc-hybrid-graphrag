// M0-016 criterion 3 (D60, D61): /api/v1/* is forwarded to grc-api, and
// GET https://grc.localhost/api/v1/health returns 200. The API itself publishes no port (D61), so
// an answer from the API here can only have come through Caddy.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiLogged, errorBody, https } from './helpers.js';

describe('criterion 3: /api/v1 goes to the API', () => {
  it('GET https://grc.localhost/api/v1/health returns 200 with the health report', async () => {
    const res = await https('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^application\/json/);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['neo4j', 'postgres', 'status']);
    expect(['ok', 'degraded']).toContain(body.status);
  });

  it('the API gets the full /api/v1 path, query string included (nothing stripped)', async () => {
    const marker = randomUUID();
    const since = new Date(Date.now() - 1_000);
    const res = await https(`/api/v1/health?probe=${marker}`);
    expect(res.status).toBe(200);
    expect(await apiLogged(`/api/v1/health?probe=${marker}`, since)).toBe(true);
  });

  it("GET /api/v1/me without a session gets the API's 401 in the error format", async () => {
    const res = await https('/api/v1/me');
    expect(res.status).toBe(401);
    expect(errorBody(res)?.code).toBeDefined();
  });

  it("the API's OpenAPI document is reachable through the door", async () => {
    const res = await https('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.text) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths ?? {})).toContain('/api/v1/health');
  });

  it('a path that only starts like the API (/api/v10) is not forwarded as /api/v1', async () => {
    const res = await https('/api/v10/health');
    expect(res.text).not.toContain('"postgres"');
  });
});
