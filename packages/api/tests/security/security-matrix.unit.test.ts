// TEST-003 (D175, D59, D50, D51, D55, D30): the D59 security matrix can't fall behind the code.
//
// `SECURITY_MATRIX` (packages/shared/src/access/security-matrix.ts, exported from `@grc/shared`) has:
//   recordTypes: one entry per row of ROLE_TABLE:
//     { subject, cells: ROLE_TABLE[subject] (the same object, not a copy), orgWalled, labels }
//   routes: one entry per API route:
//     { method: 'GET' | 'POST' | …, path: full path under /api/v1 (Nest params as `:id`, Fastify
//       wildcards as `*`), access, orgWalled, labels }
//     access is 'public', 'any signed-in', or a D50 cell reference { subject, action }, the same
//     shape as `@Requires(subject, action)`.
//
// The code side is collected without a database, a running server or .env (criterion 2):
// - Nest routes from the controllers' route metadata, walking AppModule's imports, plus the
//   global /api/v1 prefix;
// - the routes registered straight on Fastify from `DIRECT_ROUTES`, exported by
//   packages/api/src/identity/auth-routes.ts as [{ method, path }] with full paths, and checked
//   against what the register functions actually add to a Fastify instance that never listens.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller, Module, Post, RequestMethod } from '@nestjs/common';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Nest's metadata keys (@nestjs/common/constants: MODULE_METADATA, PATH_METADATA, METHOD_METADATA).
const IMPORTS_KEY = 'imports';
const CONTROLLERS_KEY = 'controllers';
const PATH_KEY = 'path';
const METHOD_KEY = 'method';

const MATRIX_FILE = fileURLToPath(new URL('../../../shared/src/access/security-matrix.ts', import.meta.url));

type CellRef = { subject: string; action: string };
type Access = 'public' | 'any signed-in' | CellRef;

interface MatrixRecordType {
  subject: string;
  cells: unknown;
  orgWalled: boolean;
  labels: boolean;
}
interface MatrixRoute {
  method: string;
  path: string;
  access: Access;
  orgWalled: boolean;
  labels: boolean;
}
interface Matrix {
  recordTypes: MatrixRecordType[];
  routes: MatrixRoute[];
}

interface CodeRoute {
  method: string;
  path: string;
  /** What the controller's metadata says; undefined for routes registered straight on Fastify. */
  access?: Access;
}

// Loaded in beforeAll, after the environment is emptied of every address and secret.
let shared: Record<string, unknown>;
let ROLE_TABLE: Record<string, unknown>;
let RECORD_TYPES: readonly string[];
let ACTIONS: readonly string[];
let AppModule: unknown;
let authRoutes: Record<string, unknown>;
let API_PREFIX: string;
let PUBLIC_ROUTE: string;
let REQUIRES_KEY: string;
let registerAll: (fastify: ReturnType<typeof Fastify>) => void;

const savedEnv: Record<string, string | undefined> = {};
const ENV_TO_HIDE = /^(DATABASE_URL|NEO4J|S3_|SEAWEED|BETTER_AUTH|AUTH_|OLLAMA|PG|POSTGRES|API_KEY)/i;

beforeAll(async () => {
  // Criterion 2: nothing here may need .env. Hide anything that looks like an address or secret.
  for (const key of Object.keys(process.env)) {
    if (ENV_TO_HIDE.test(key)) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  shared = (await import('@grc/shared')) as Record<string, unknown>;
  ROLE_TABLE = shared.ROLE_TABLE as Record<string, unknown>;
  RECORD_TYPES = shared.RECORD_TYPES as readonly string[];
  ACTIONS = shared.ACTIONS as readonly string[];
  AppModule = (await import('../../src/app.module.js')).AppModule;
  authRoutes = (await import('../../src/identity/auth-routes.js')) as Record<string, unknown>;
  API_PREFIX = (await import('../../src/common/openapi.js')).API_PREFIX;
  PUBLIC_ROUTE = (await import('../../src/identity/session.guard.js')).PUBLIC_ROUTE;
  REQUIRES_KEY = (await import('../../src/access/requires.decorator.js')).REQUIRES_KEY;
  const { registerSecurityHeaders } = await import('../../src/common/security-headers.js');
  const { RateLimiter, registerRateLimit, REQUESTS_PER_MINUTE } = await import('../../src/common/rate-limit.js');
  const { registerSessionHook, registerAuthRoutes } = authRoutes as typeof import('../../src/identity/auth-routes.js');
  // The same calls as createApiApp in main.api.ts, with an AuthService stand-in: no handler runs.
  const auth = { useLogger: () => undefined } as never;
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
  registerAll = (fastify) => {
    registerSecurityHeaders(fastify);
    registerSessionHook(fastify, auth);
    registerRateLimit(fastify, new RateLimiter(REQUESTS_PER_MINUTE));
    registerAuthRoutes(fastify, auth, log);
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
});

function matrix(): Matrix {
  const m = shared.SECURITY_MATRIX as Matrix | undefined;
  expect(m, 'SECURITY_MATRIX is exported from @grc/shared').toBeDefined();
  return m!;
}

// ---- collecting the code side ------------------------------------------------------------------

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function joinPath(...parts: string[]): string {
  const segments = parts.flatMap((p) => p.split('/')).filter((s) => s.length > 0);
  return '/' + segments.join('/');
}

type Ctor = abstract new (...args: never[]) => unknown;
type Handler = (...args: never[]) => unknown;

function controllersOf(root: unknown): Ctor[] {
  const seen = new Set<unknown>();
  const found: Ctor[] = [];
  const visit = (entry: unknown): void => {
    if (!entry) return;
    if (typeof entry === 'object' && 'forwardRef' in entry) {
      visit((entry as { forwardRef: () => unknown }).forwardRef());
      return;
    }
    if (typeof entry === 'object' && 'module' in entry) {
      // A dynamic module: its own lists plus the module class's metadata.
      const dyn = entry as { module: unknown; imports?: unknown[]; controllers?: Ctor[] };
      for (const c of dyn.controllers ?? []) if (!found.includes(c)) found.push(c);
      for (const i of dyn.imports ?? []) visit(i);
      visit(dyn.module);
      return;
    }
    if (typeof entry !== 'function' || seen.has(entry)) return;
    seen.add(entry);
    for (const c of (Reflect.getMetadata(CONTROLLERS_KEY, entry) as Ctor[] | undefined) ?? []) {
      if (!found.includes(c)) found.push(c);
    }
    for (const i of (Reflect.getMetadata(IMPORTS_KEY, entry) as unknown[] | undefined) ?? []) visit(i);
  };
  visit(root);
  return found;
}

function accessFromMetadata(controller: Ctor, handler: Handler): Access {
  const isPublic = Reflect.getMetadata(PUBLIC_ROUTE, handler) ?? Reflect.getMetadata(PUBLIC_ROUTE, controller);
  if (isPublic === true) return 'public';
  const req = (Reflect.getMetadata(REQUIRES_KEY, handler) ?? Reflect.getMetadata(REQUIRES_KEY, controller)) as
    | CellRef
    | undefined;
  if (req) return { subject: req.subject, action: req.action };
  return 'any signed-in';
}

function nestRoutes(root: unknown): CodeRoute[] {
  const routes: CodeRoute[] = [];
  for (const controller of controllersOf(root)) {
    const base = asArray(Reflect.getMetadata(PATH_KEY, controller) as string | string[] | undefined);
    const names = new Set<string>();
    for (let proto = controller.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) if (name !== 'constructor') names.add(name);
    }
    for (const name of names) {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const methodNo = Reflect.getMetadata(METHOD_KEY, handler) as RequestMethod | undefined;
      const paths = Reflect.getMetadata(PATH_KEY, handler) as string | string[] | undefined;
      if (methodNo === undefined || paths === undefined) continue;
      const method = RequestMethod[methodNo];
      for (const b of base.length > 0 ? base : ['']) {
        for (const p of asArray(paths)) {
          routes.push({
            method,
            path: joinPath(API_PREFIX, b, p),
            access: accessFromMetadata(controller, handler as Handler),
          });
        }
      }
    }
  }
  return routes;
}

function directRoutes(): CodeRoute[] {
  const list = authRoutes.DIRECT_ROUTES as { method: string; path: string }[] | undefined;
  expect(list, 'DIRECT_ROUTES is exported from src/identity/auth-routes.ts').toBeDefined();
  return list!.map((r) => ({ method: r.method, path: r.path }));
}

function codeSide(root: unknown = AppModule): { subjects: string[]; routes: CodeRoute[] } {
  return { subjects: Object.keys(ROLE_TABLE), routes: [...nestRoutes(root), ...directRoutes()] };
}

// ---- comparing ---------------------------------------------------------------------------------

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const show = (a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a));
const sameAccess = (a: Access, b: Access) => show(a) === show(b);

function isKnownAccess(access: unknown): access is Access {
  if (access === 'public' || access === 'any signed-in') return true;
  if (!access || typeof access !== 'object') return false;
  const { subject, action } = access as Partial<CellRef>;
  return (
    typeof subject === 'string' &&
    Object.hasOwn(ROLE_TABLE, subject) &&
    typeof action === 'string' &&
    ACTIONS.includes(action)
  );
}

/** Every disagreement between the code and the matrix, each naming its item. Empty means in step. */
function matrixProblems(code: { subjects: string[]; routes: CodeRoute[] }, m: Matrix): string[] {
  const problems: string[] = [];

  // Record types (the rows of ROLE_TABLE).
  const listedTypes = new Map<string, number>();
  for (const t of m.recordTypes) listedTypes.set(t.subject, (listedTypes.get(t.subject) ?? 0) + 1);
  for (const s of code.subjects) {
    if (!listedTypes.has(s)) problems.push(`record type ${s} is in the role table but missing from the matrix`);
  }
  for (const [s, n] of listedTypes) {
    if (!code.subjects.includes(s)) problems.push(`record type ${s} is in the matrix but not in the role table`);
    if (n > 1) problems.push(`record type ${s} is listed ${n} times`);
  }
  for (const t of m.recordTypes) {
    if (!code.subjects.includes(t.subject)) continue;
    if (t.cells !== ROLE_TABLE[t.subject]) {
      problems.push(`record type ${t.subject}: cells must be ROLE_TABLE.${t.subject} itself, not a copy`);
    }
    if (typeof t.orgWalled !== 'boolean') problems.push(`record type ${t.subject}: orgWalled is not true/false`);
    if (typeof t.labels !== 'boolean') problems.push(`record type ${t.subject}: labels is not true/false`);
  }

  // Routes.
  const codeByKey = new Map(code.routes.map((r) => [key(r), r]));
  const listedRoutes = new Map<string, number>();
  for (const r of m.routes) listedRoutes.set(key(r), (listedRoutes.get(key(r)) ?? 0) + 1);
  for (const r of code.routes) {
    if (!listedRoutes.has(key(r))) problems.push(`route ${key(r)} is in the code but missing from the matrix`);
  }
  for (const [k, n] of listedRoutes) {
    if (!codeByKey.has(k)) problems.push(`route ${k} is in the matrix but the API doesn't serve it`);
    if (n > 1) problems.push(`route ${k} is listed ${n} times`);
  }
  for (const r of m.routes) {
    const k = key(r);
    if (!isKnownAccess(r.access)) {
      problems.push(`route ${k} has an unknown access value ${show(r.access)}`);
      continue;
    }
    if (typeof r.orgWalled !== 'boolean') problems.push(`route ${k}: orgWalled is not true/false`);
    if (typeof r.labels !== 'boolean') problems.push(`route ${k}: labels is not true/false`);
    const fromCode = codeByKey.get(k)?.access;
    if (fromCode !== undefined && !sameAccess(fromCode, r.access)) {
      problems.push(`route ${k}: the matrix says ${show(r.access)} but the code says ${show(fromCode)}`);
    }
  }
  return problems;
}

// ---- tests -------------------------------------------------------------------------------------

describe('criterion 2: the code side is collected from metadata, with no database, server or .env', () => {
  it('finds every Nest controller route the API has today, with the /api/v1 prefix', () => {
    const found = nestRoutes(AppModule).map(key);
    expect(found).toEqual(
      expect.arrayContaining([
        'GET /api/v1/health',
        'GET /api/v1/me',
        'POST /api/v1/api-keys',
        'GET /api/v1/api-keys',
        'DELETE /api/v1/api-keys/:id',
        'GET /api/v1/openapi.json',
      ]),
    );
  });

  it('reads access from the controllers: health is public, /me any signed-in, API keys need the admin cell', () => {
    const byKey = new Map(nestRoutes(AppModule).map((r) => [key(r), r.access]));
    expect(byKey.get('GET /api/v1/health')).toBe('public');
    expect(byKey.get('GET /api/v1/me')).toBe('any signed-in');
    expect(byKey.get('GET /api/v1/openapi.json')).toBe('any signed-in');
    expect(byKey.get('DELETE /api/v1/api-keys/:id')).toEqual({ subject: 'admin', action: 'edit' });
  });

  it('DIRECT_ROUTES lists the Better Auth wildcard under AUTH_BASE_PATH for GET and POST', async () => {
    const { AUTH_BASE_PATH } = await import('../../src/identity/auth.js');
    expect(directRoutes().map(key).sort()).toEqual([`GET ${AUTH_BASE_PATH}/*`, `POST ${AUTH_BASE_PATH}/*`]);
  });

  it('DIRECT_ROUTES matches exactly what main.api.ts registers straight on Fastify', async () => {
    const fastify = Fastify({ exposeHeadRoutes: false });
    const registered: string[] = [];
    fastify.addHook('onRoute', (opts) => {
      for (const method of asArray(opts.method)) registered.push(`${method} ${opts.url}`);
    });
    registerAll(fastify);
    await fastify.ready();
    await fastify.close();
    expect(registered.length).toBeGreaterThan(0);
    expect(directRoutes().map(key).sort()).toEqual(registered.sort());
  });
});

describe('criterion 1: the matrix lists every record type and every route, with every field', () => {
  it('is exported from @grc/shared with recordTypes and routes lists', () => {
    const m = matrix();
    expect(Array.isArray(m.recordTypes)).toBe(true);
    expect(Array.isArray(m.routes)).toBe(true);
  });

  it('agrees with the code: no missing, extra, duplicated or wrongly guarded item', () => {
    expect(matrixProblems(codeSide(), matrix())).toEqual([]);
  });

  it('has one record-type entry per ROLE_TABLE row, each pointing at the role table row itself (D50)', () => {
    const m = matrix();
    expect(m.recordTypes.map((t) => t.subject).sort()).toEqual(Object.keys(ROLE_TABLE).sort());
    for (const t of m.recordTypes) expect(t.cells, t.subject).toBe(ROLE_TABLE[t.subject]);
  });

  it('marks every D50 row as org-walled (D55)', () => {
    for (const t of matrix().recordTypes) expect(t.orgWalled, t.subject).toBe(true);
  });

  it('marks labels on for every record type, since every record carries a label (D51, D66)', () => {
    const m = matrix();
    for (const type of RECORD_TYPES) {
      const entry = m.recordTypes.find((t) => t.subject === type);
      expect(entry?.labels, type).toBe(true);
    }
    for (const t of m.recordTypes) expect(typeof t.labels, t.subject).toBe('boolean');
  });

  it('gives every route a method, a full /api/v1 path, a known access value and org and label flags (D30)', () => {
    for (const r of matrix().routes) {
      const k = key(r);
      expect(r.method, k).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(r.path.startsWith('/api/v1/'), k).toBe(true);
      expect(isKnownAccess(r.access), `${k} access ${show(r.access)}`).toBe(true);
      expect(typeof r.orgWalled, k).toBe('boolean');
      expect(typeof r.labels, k).toBe('boolean');
    }
  });

  it('lists the Better Auth wildcard as public and not org-walled', () => {
    const auth = matrix().routes.filter((r) => r.path === '/api/v1/auth/*');
    expect(auth.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    for (const r of auth) {
      expect(r.access, key(r)).toBe('public');
      expect(r.orgWalled, key(r)).toBe(false);
    }
  });

  it('never marks a public route as org-walled, and marks every D50-cell route org-walled (D55)', () => {
    for (const r of matrix().routes) {
      if (r.access === 'public') expect(r.orgWalled, key(r)).toBe(false);
      if (typeof r.access === 'object') expect(r.orgWalled, key(r)).toBe(true);
    }
  });

  it('marks labels on for every route guarded by a record-type cell (D51)', () => {
    for (const r of matrix().routes) {
      if (typeof r.access === 'object' && RECORD_TYPES.includes(r.access.subject)) {
        expect(r.labels, key(r)).toBe(true);
      }
    }
  });

  it('marks /me and the API-key routes as org-walled (D55)', () => {
    const byKey = new Map(matrix().routes.map((r) => [key(r), r]));
    for (const k of ['GET /api/v1/me', 'POST /api/v1/api-keys', 'GET /api/v1/api-keys', 'DELETE /api/v1/api-keys/:id']) {
      expect(byKey.get(k)?.orgWalled, k).toBe(true);
    }
  });
});

describe('criterion 3: the check fails and names the item', () => {
  const clone = (): Matrix => {
    const m = matrix();
    return { recordTypes: [...m.recordTypes], routes: m.routes.map((r) => ({ ...r })) };
  };

  it('names a record type in the role table that the matrix leaves out', () => {
    const m = clone();
    m.recordTypes = m.recordTypes.filter((t) => t.subject !== 'incident');
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('incident');
  });

  it('names a record type in the matrix that the role table does not have', () => {
    const m = clone();
    m.recordTypes.push({ subject: 'widget', cells: {}, orgWalled: true, labels: true });
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('widget');
  });

  it('names a route in the code that the matrix leaves out', () => {
    const m = clone();
    m.routes = m.routes.filter((r) => key(r) !== 'DELETE /api/v1/api-keys/:id');
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DELETE /api/v1/api-keys/:id');
  });

  it('names a route in the matrix that the API does not serve', () => {
    const m = clone();
    m.routes.push({ method: 'GET', path: '/api/v1/ghost', access: 'any signed-in', orgWalled: true, labels: false });
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GET /api/v1/ghost');
  });

  it('names a duplicated route', () => {
    const m = clone();
    const health = m.routes.find((r) => key(r) === 'GET /api/v1/health');
    expect(health).toBeDefined();
    m.routes.push({ ...health! });
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GET /api/v1/health');
  });

  it.each([
    ['a made-up word', 'anyone'],
    ['an unknown subject', { subject: 'widget', action: 'view' }],
    ['an unknown action', { subject: 'asset', action: 'fly' }],
  ])('names a route whose access is %s', (_label, access) => {
    const m = clone();
    const me = m.routes.find((r) => key(r) === 'GET /api/v1/me');
    expect(me).toBeDefined();
    me!.access = access as Access;
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GET /api/v1/me');
    expect(problems[0]).toContain('unknown access');
  });

  it('names a route whose access disagrees with the controller', () => {
    const m = clone();
    const keys = m.routes.find((r) => key(r) === 'POST /api/v1/api-keys');
    expect(keys).toBeDefined();
    keys!.access = 'any signed-in';
    const problems = matrixProblems(codeSide(), m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('POST /api/v1/api-keys');
  });
});

describe('criterion 4: a new controller method without a matrix entry fails the check', () => {
  it('names a throwaway controller route mounted next to AppModule', () => {
    class ThrowawayProbeController {
      poke(): string {
        return 'poked';
      }
    }
    Controller('throwaway-probe')(ThrowawayProbeController);
    Post('poke')(
      ThrowawayProbeController.prototype,
      'poke',
      Object.getOwnPropertyDescriptor(ThrowawayProbeController.prototype, 'poke')!,
    );
    class ThrowawayProbeModule {}
    Module({ controllers: [ThrowawayProbeController] })(ThrowawayProbeModule);
    // The same way createApiApp mounts extra modules next to AppModule.
    class RootWithProbe {}
    Module({ imports: [AppModule as never, ThrowawayProbeModule] })(RootWithProbe);

    const problems = matrixProblems(codeSide(RootWithProbe), matrix());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('POST /api/v1/throwaway-probe/poke');
    expect(problems[0]).toContain('missing from the matrix');
  });
});

describe('criterion 5: the matrix file tells the security reviewer to check it (D175, D59)', () => {
  it("has a header comment naming D59, D175 and the security reviewer's check on every task", () => {
    let source = '';
    try {
      source = readFileSync(MATRIX_FILE, 'utf8');
    } catch {
      // Missing file: the assertion below names it.
    }
    expect(source, MATRIX_FILE).not.toBe('');
    const header = source.slice(0, source.search(/^\s*(import|export)\b/m));
    expect(header).toMatch(/D59/);
    expect(header).toMatch(/D175/);
    expect(header).toMatch(/security reviewer/i);
    expect(header).toMatch(/every task/i);
  });
});
