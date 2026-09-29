// `pnpm gen:api-client` (D30): writes packages/web/src/api/client.ts, the web app's typed API client,
// from the API's OpenAPI document (the one served at /api/v1/openapi.json).
//
// - With no argument, the document is built in-process from the API sources (no running API needed).
// - With `--from <file or URL>`, it is read from a saved file or fetched from a running API.
//
// The client only ever uses relative /api/v1 addresses, so the browser talks to the page's own
// origin (Caddy forwards /api/v1 to the API, D60). Run with plain `node` (type stripping).
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;

const API = fileURLToPath(new URL('../../api/', import.meta.url));
const OUT = fileURLToPath(new URL('../src/api/client.ts', import.meta.url));

async function documentFromSources(): Promise<Json> {
  // The API sources import each other as `./x.js`, which are `./x.ts` files.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw err;
      }
    },
  });
  const requireFromApi = createRequire(new URL('package.json', pathToFileURL(API)));
  await import(pathToFileURL(requireFromApi.resolve('reflect-metadata')).href);
  // Loading the root module registers every documented route; nothing is started or connected.
  await import(new URL('src/app.module.ts', pathToFileURL(API)).href);
  const openapi = (await import(new URL('src/common/openapi.ts', pathToFileURL(API)).href)) as {
    openApiDocument: () => Json;
  };
  return openapi.openApiDocument();
}

async function documentFrom(source: string): Promise<Json> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetching the OpenAPI document failed: HTTP ${res.status}`);
    return (await res.json()) as Json;
  }
  return JSON.parse(await readFile(source, 'utf8')) as Json;
}

// ---- JSON Schema to TypeScript -------------------------------------------------------------

function tsType(schema: unknown, indent = ''): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const s = schema as Json;
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(union)) return union.map((u) => tsType(u, indent)).join(' | ');
  if (Array.isArray(s.allOf)) return s.allOf.map((u) => tsType(u, indent)).join(' & ');
  switch (s.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${tsType(s.items, indent)}>`;
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required as string[] | undefined) ?? []);
      const inner = `${indent}  `;
      const lines = Object.entries(props).map(
        ([key, value]) =>
          `${inner}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${tsType(value, inner)};`,
      );
      if (lines.length === 0) return 'Record<string, never>';
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

function pascal(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/** `post /api/v1/auth/two-factor/verify-totp` → `postAuthTwoFactorVerifyTotp`. */
function operationName(method: string, path: string): string {
  const words = path
    .replace(/^\/api\/v1\//, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return method + pascal(words);
}

function jsonSchemaOf(content: unknown): unknown {
  return (content as { 'application/json'?: { schema?: unknown } } | undefined)?.['application/json']?.schema;
}

interface Operation {
  name: string;
  method: string;
  path: string;
  summary: string;
  body?: unknown;
  response: unknown;
  /** The `{name}` parts of the path, in order. */
  pathParams: string[];
  /** A paged list (D47) takes its page, sort and filters as query parameters. */
  paged: boolean;
  /** The documented query parameters of a route that isn't a paged list, as an object schema. */
  query?: Json;
}

/** The OpenAPI `in: query` parameters as one object schema, or undefined when there are none. */
function querySchemaOf(parameters: unknown): Json | undefined {
  if (!Array.isArray(parameters)) return undefined;
  const params = (parameters as Json[]).filter((p) => p.in === 'query');
  if (params.length === 0) return undefined;
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [String(p.name), p.schema ?? {}])),
    required: params.filter((p) => p.required === true).map((p) => String(p.name)),
  };
}

/** A GET whose answer is `{ items, page, pageSize, total }`. */
function isPaged(method: string, response: unknown): boolean {
  if (method !== 'get' || !response || typeof response !== 'object') return false;
  const props = (response as Json).properties as Json | undefined;
  return !!props && ['items', 'page', 'pageSize', 'total'].every((key) => key in props);
}

function operations(doc: Json): Operation[] {
  const out: Operation[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const path of Object.keys(paths).sort()) {
    if (!path.startsWith('/api/v1/')) throw new Error(`not an /api/v1 path: ${path}`);
    for (const [method, op] of Object.entries(paths[path]!)) {
      const responses = (op.responses ?? {}) as Record<string, { content?: unknown }>;
      out.push({
        name: operationName(method, path),
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? ''),
        body: jsonSchemaOf((op.requestBody as { content?: unknown } | undefined)?.content),
        response: jsonSchemaOf(responses['200']?.content),
        pathParams: [...path.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]!),
        paged: isPaged(method, jsonSchemaOf(responses['200']?.content)),
        query: querySchemaOf(op.parameters),
      });
    }
  }
  return out;
}

const RUNTIME = `/** The API's one error format (D47). */
export interface ApiErrorBody {
  error: { code: string; message: string; referenceId: string };
}

/** A refused request, with the API's code, message and reference ID. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly referenceId: string | undefined;
  /** From the Retry-After header (for example the sign-in lock), in seconds. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string, message: string, referenceId?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.referenceId = referenceId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached. Check your connection and try again.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data as Partial<ApiErrorBody> | undefined)?.error;
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? 'The request was refused.',
      err?.referenceId,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return data as T;
}

/** A paged list's query parameters (D47): page, pageSize, sort and the list's filters. */
export type ListQuery = Record<string, string | number | undefined>;

/** \`?a=1&b=x\`, leaving out empty values; an empty string when nothing is left. */
function queryString(query?: ListQuery): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? \`?\${text}\` : '';
}`;

function render(doc: Json): string {
  const ops = operations(doc);
  const types: string[] = [];
  const methods: string[] = [];
  for (const op of ops) {
    const base = op.name.charAt(0).toUpperCase() + op.name.slice(1);
    types.push(`/** ${op.method} ${op.path} response. */\nexport type ${base}Response = ${tsType(op.response)};`);
    if (op.body !== undefined) {
      types.push(`/** ${op.method} ${op.path} request body. */\nexport type ${base}Body = ${tsType(op.body)};`);
    }
    const args: string[] = [];
    if (op.pathParams.length > 0) args.push(`path: { ${op.pathParams.map((p) => `${p}: string`).join('; ')} }`);
    if (op.body !== undefined) args.push(`body: ${base}Body`);
    if (op.paged) {
      args.push('query?: ListQuery');
    } else if (op.query !== undefined) {
      types.push(`/** ${op.method} ${op.path} query parameters. */\nexport type ${base}Query = ${tsType(op.query)};`);
      args.push(`query?: ${base}Query`);
    }
    const hasQuery = op.paged || op.query !== undefined;
    // Path parameters are URL-encoded into the relative address; the query is appended.
    const address =
      op.pathParams.length > 0 || hasQuery
        ? `\`${op.path.replace(/\{([A-Za-z_$][\w$]*)\}/g, (_m, p: string) => `\${encodeURIComponent(path.${p})}`)}${hasQuery ? '${queryString(query)}' : ''}\``
        : `'${op.path}'`;
    const call =
      op.body !== undefined
        ? `request<${base}Response>('${op.method}', ${address}, body)`
        : `request<${base}Response>('${op.method}', ${address})`;
    methods.push(`  /** ${op.summary} */\n  ${op.name}: (${args.join(', ')}): Promise<${base}Response> => ${call},`);
  }
  return `// Generated by \`pnpm gen:api-client\` from the API's OpenAPI document (/api/v1/openapi.json).
// Do not edit by hand: change the API's Zod schemas and generate again (D30).
// Every address is relative, so requests go to the page's own origin.

${RUNTIME}

${types.join('\n\n')}

export const api = {
${methods.join('\n')}
};
`;
}

const fromIndex = process.argv.indexOf('--from');
const source = fromIndex > 0 ? process.argv[fromIndex + 1] : undefined;
const doc = source ? await documentFrom(source) : await documentFromSources();
const prettier = await import('prettier');
const options = (await prettier.resolveConfig(OUT)) ?? {};
writeFileSync(OUT, await prettier.format(render(doc), { ...options, filepath: OUT }));
console.log(`gen:api-client: wrote ${operations(doc).length} operations to src/api/client.ts`);
