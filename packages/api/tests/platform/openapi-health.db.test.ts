// M0-007 criterion 6 (D30, D47) and the health route from the brief's "Interfaces".
// 6. The OpenAPI document lists the health route with its Zod-derived schema.
// GET /api/v1/health returns { status, postgres, neo4j }. GET /api/v1/openapi.json is generated
// from the Zod schemas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREFIX, platformDb, startApi, type ApiApp, type PlatformDb } from './helpers.js';
import { signedInApi } from '../auth/helpers.js';

let db: PlatformDb | undefined;
let app: ApiApp | undefined;
let session: Awaited<ReturnType<typeof signedInApi>> | undefined;

beforeAll(async () => {
  db = await platformDb();
  app = await startApi();
  session = await signedInApi(app, db);
}, 180_000);

afterAll(async () => {
  await session?.close();
  await app?.close();
  await db?.drop();
});

// Since M0-010 every route except /api/v1/auth/* and /api/v1/health needs a signed-in session
// with MFA checked, so these requests carry one (signedInApi from the auth helpers).
function api(): ApiApp {
  if (!session) throw new Error('the API app or its signed-in session did not start (see beforeAll)');
  return session.api;
}

type Json = Record<string, unknown>;

async function openapi(): Promise<Json> {
  const res = await api().inject({ method: 'GET', url: `${PREFIX}/openapi.json` });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

function resolveRef(doc: Json, schema: Json): Json {
  let current = schema;
  for (let i = 0; i < 10 && typeof current.$ref === 'string'; i++) {
    const path = (current.$ref as string).replace(/^#\//, '').split('/');
    let node: unknown = doc;
    for (const part of path) node = (node as Json)[part];
    current = node as Json;
  }
  return current;
}

function healthSchema(doc: Json): Json {
  const paths = doc.paths as Json;
  const get = (paths[`${PREFIX}/health`] as Json | undefined)?.get as Json | undefined;
  expect(get, 'paths["/api/v1/health"].get').toBeDefined();
  const ok = (get!.responses as Json)['200'] as Json | undefined;
  expect(ok, 'responses["200"]').toBeDefined();
  const schema = ((ok!.content as Json)['application/json'] as Json).schema as Json;
  return resolveRef(doc, schema);
}

describe('GET /api/v1/health', () => {
  it('returns 200 with status, postgres and neo4j', async () => {
    const res = await api().inject({ method: 'GET', url: `${PREFIX}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(Object.keys(body).sort()).toEqual(['neo4j', 'postgres', 'status']);
    for (const key of ['status', 'postgres', 'neo4j']) {
      expect(typeof body[key], key).toBe('string');
      expect((body[key] as string).length, key).toBeGreaterThan(0);
    }
  });

  it('matches its own Zod schema', async () => {
    const mod = (await import('../../src/health/health.controller.js')) as {
      healthResponseSchema?: { parse(v: unknown): unknown };
    };
    expect(mod.healthResponseSchema, 'health.controller.ts exports healthResponseSchema').toBeDefined();
    const res = await api().inject({ method: 'GET', url: `${PREFIX}/health` });
    expect(() => mod.healthResponseSchema!.parse(res.json())).not.toThrow();
  });
});

describe('criterion 6: the OpenAPI document', () => {
  it('is served at /api/v1/openapi.json as an OpenAPI 3 document', async () => {
    const doc = await openapi();
    expect(String(doc.openapi)).toMatch(/^3\./);
    expect(doc.info).toBeDefined();
    expect(doc.paths).toBeDefined();
  });

  it('lists only /api/v1 paths', async () => {
    const paths = Object.keys((await openapi()).paths as Json);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(`${PREFIX}/`), p).toBe(true);
  });

  it('lists GET /api/v1/health with a 200 JSON schema of status, postgres and neo4j as strings', async () => {
    const schema = healthSchema(await openapi());
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, Json>;
    expect(Object.keys(props).sort()).toEqual(['neo4j', 'postgres', 'status']);
    for (const key of ['status', 'postgres', 'neo4j']) {
      const prop = resolveRef({}, props[key]!);
      const isString =
        prop.type === 'string' || (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === 'string'));
      expect(isString, `${key}: ${JSON.stringify(prop)}`).toBe(true);
    }
    expect([...((schema.required as string[] | undefined) ?? [])].sort()).toEqual(['neo4j', 'postgres', 'status']);
  });

  it('derives the health schema from the Zod schema (same fields, same enum values)', async () => {
    const mod = (await import('../../src/health/health.controller.js')) as {
      healthResponseSchema?: { shape: Record<string, { options?: unknown[] }> };
    };
    const zod = mod.healthResponseSchema;
    expect(zod, 'health.controller.ts exports healthResponseSchema').toBeDefined();
    const schema = healthSchema(await openapi());
    const props = schema.properties as Record<string, Json>;
    expect(Object.keys(props).sort()).toEqual(Object.keys(zod!.shape).sort());
    for (const [key, field] of Object.entries(zod!.shape)) {
      if (Array.isArray(field.options)) {
        expect([...(props[key]!.enum as unknown[])].sort(), `${key} enum`).toEqual([...field.options].sort());
      }
    }
  });
});
