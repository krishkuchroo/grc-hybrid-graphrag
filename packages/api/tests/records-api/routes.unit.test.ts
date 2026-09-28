// S1-004 criterion 1 (D30, D47, D175, D59): the 25 record routes and GET /api/v1/people exist under
// /api/v1, are in the OpenAPI document with their Zod schemas, and each has its row in
// SECURITY_MATRIX:
// - the record routes: access { subject: <kind>, action: 'view'|'edit' }, orgWalled true, labels true;
// - people: 'any signed-in', orgWalled true, labels false.
// The TEST-003 completeness test (tests/security/security-matrix.unit.test.ts) checks that the code
// and the matrix agree; this file pins the rows themselves. No database, server or .env.
import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { RECORD_KINDS, RECORD_PATHS, SECURITY_MATRIX, type RecordKind } from '@grc/shared';

type Method = 'GET' | 'POST' | 'PATCH';
interface Expected {
  method: Method;
  path: string;
  access: 'any signed-in' | { subject: RecordKind; action: 'view' | 'edit' };
  orgWalled: boolean;
  labels: boolean;
  /** The request takes a JSON body. */
  body: boolean;
}

function recordRoutes(kind: RecordKind): Expected[] {
  const p = `/api/v1/${RECORD_PATHS[kind]}`;
  const view = { subject: kind, action: 'view' as const };
  const edit = { subject: kind, action: 'edit' as const };
  const row = (method: Method, path: string, access: Expected['access'], body: boolean): Expected => ({
    method,
    path,
    access,
    orgWalled: true,
    labels: true,
    body,
  });
  return [
    row('GET', p, view, false),
    row('GET', `${p}/:id`, view, false),
    row('POST', p, edit, true),
    row('PATCH', `${p}/:id`, edit, true),
    row('POST', `${p}/:id/retire`, edit, true),
  ];
}

const RECORD_ROUTES = RECORD_KINDS.flatMap(recordRoutes);
const PEOPLE: Expected = {
  method: 'GET',
  path: '/api/v1/people',
  access: 'any signed-in',
  orgWalled: true,
  labels: false,
  body: false,
};
const ALL = [...RECORD_ROUTES, PEOPLE];

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

let doc: { paths: Record<string, Record<string, Record<string, unknown>>> };

beforeAll(async () => {
  // Importing the app module loads every controller, and with it every documentRoute call.
  await import('../../src/app.module.js');
  const { openApiDocument } = await import('../../src/common/openapi.js');
  doc = openApiDocument() as typeof doc;
});

/** The document's operation for a route, with `{id}` or `:id` path parameters. */
function operation(method: string, path: string): Record<string, unknown> | undefined {
  for (const [docPath, ops] of Object.entries(doc.paths)) {
    if (docPath.replace(/\{(\w+)\}/g, ':$1') === path) return ops[method.toLowerCase()];
  }
  return undefined;
}

/** The route's operation; fails the test, naming the route, when it is not documented. */
function documented(method: string, path: string): Record<string, unknown> {
  const op = operation(method, path);
  expect(op, `${method} ${path} in the OpenAPI document`).toBeDefined();
  return op!;
}

/** The JSON schema of the success answer; fails the test when there is none. */
function answerSchema(method: string, path: string): Record<string, unknown> {
  const schema = responseSchema(documented(method, path));
  expect(schema, `${method} ${path} response schema`).toBeDefined();
  return schema!;
}

function responseSchema(op: Record<string, unknown>): Record<string, unknown> | undefined {
  const responses = op['responses'] as Record<string, { content?: Record<string, { schema?: unknown }> }> | undefined;
  const ok = responses?.['200'] ?? responses?.['201'];
  return ok?.content?.['application/json']?.schema as Record<string, unknown> | undefined;
}

describe('criterion 1: the security matrix rows (D175, D59)', () => {
  it('lists 25 record routes, 5 per kind', () => {
    expect(RECORD_ROUTES).toHaveLength(25);
  });

  it.each(ALL)('$method $path has exactly one row with its access, org wall and label flags', (want) => {
    const rows = SECURITY_MATRIX.routes.filter((r) => key(r) === key(want));
    expect(rows, `rows for ${key(want)}`).toHaveLength(1);
    expect(rows[0]).toEqual({
      method: want.method,
      path: want.path,
      access: want.access,
      orgWalled: want.orgWalled,
      labels: want.labels,
    });
  });

  it('keeps the rows that were there before (no M0 row removed)', () => {
    const keys = SECURITY_MATRIX.routes.map(key);
    for (const k of [
      'GET /api/v1/health',
      'GET /api/v1/openapi.json',
      'GET /api/v1/me',
      'POST /api/v1/api-keys',
      'GET /api/v1/api-keys',
      'DELETE /api/v1/api-keys/:id',
      'GET /api/v1/auth/*',
      'POST /api/v1/auth/*',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('adds no DELETE route for records: they are retired, never deleted (D69)', () => {
    for (const kind of RECORD_KINDS) {
      expect(SECURITY_MATRIX.routes.map(key)).not.toContain(`DELETE /api/v1/${RECORD_PATHS[kind]}/:id`);
    }
  });
});

describe('criterion 1: the OpenAPI document lists each route with its Zod schemas (D30)', () => {
  it.each(ALL)('$method $path is documented with a JSON response schema', ({ method, path }) => {
    const op = documented(method, path);
    expect(typeof op['summary']).toBe('string');
    answerSchema(method, path);
  });

  it.each(ALL.filter((r) => r.body))('$method $path documents its JSON request body', ({ method, path }) => {
    const op = documented(method, path);
    const body = op['requestBody'] as { content?: Record<string, { schema?: unknown }> } | undefined;
    expect(body?.content?.['application/json']?.schema, `${method} ${path} request body schema`).toBeDefined();
  });

  it.each(RECORD_KINDS)('the %s list answer is Paged (items, page, pageSize, total)', (kind) => {
    const schema = answerSchema('GET', `/api/v1/${RECORD_PATHS[kind]}`);
    const props = Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {});
    expect(props).toEqual(expect.arrayContaining(['items', 'page', 'pageSize', 'total']));
  });

  it.each(RECORD_KINDS)('the %s record answer has the record fields, the label as `label`', (kind) => {
    const schema = answerSchema('GET', `/api/v1/${RECORD_PATHS[kind]}/:id`);
    const props = Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {});
    expect(props).toEqual(expect.arrayContaining(['id', 'number', 'name', 'label', 'status', 'owner', 'version']));
  });

  it('the people answer is Paged, with { id, name, role } items only', () => {
    const schema = answerSchema('GET', '/api/v1/people');
    const props = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['items', 'page', 'pageSize', 'total']));
    const item = (props['items']?.['items'] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    expect(Object.keys(item).sort()).toEqual(['id', 'name', 'role']);
  });
});
