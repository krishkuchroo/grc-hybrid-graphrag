// `pnpm gen:api-client` (D30): writes packages/web/src/api/client.ts, the web app's typed API client,
// from the API's OpenAPI document (the one served at /api/v1/openapi.json).
//
// - With no argument, the document is built in-process from the API sources (no running API needed).
// - With `--from <file or URL>`, it is read from a saved file or fetched from a running API.
//
// The client only ever uses relative /api/v1 addresses, so the browser talks to the page's own
// origin (Caddy forwards /api/v1 to the API, D60). Run with plain `node` (type stripping).
//
// - A JSON body becomes the method's `body`. A multipart/form-data body (an upload) becomes a
//   `body` of its text fields and files (`Blob`s), sent as a form that reports its progress.
// - A GET answering 200 with a bare string is a file download: it answers with the file as a
//   `Blob`, its type and the name from Content-Disposition.
// - The response type is every 2xx JSON answer, so a route that answers 200 or 201 types both.
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
      // A multipart form's file part.
      return s.format === 'binary' ? 'Blob' : 'string';
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

function multipartSchemaOf(content: unknown): unknown {
  return (content as { 'multipart/form-data'?: { schema?: unknown } } | undefined)?.['multipart/form-data']?.schema;
}

/** Every 2xx JSON answer's schema, as one union when there are several. */
function successSchemaOf(responses: Record<string, { content?: unknown }>): unknown {
  const schemas = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .sort()
    .map((status) => jsonSchemaOf(responses[status]?.content))
    .filter((schema) => schema !== undefined);
  if (schemas.length <= 1) return schemas[0];
  return { anyOf: schemas };
}

/** A GET whose 200 answer is documented as a bare string answers with the file itself. */
function isFileAnswer(method: string, response: unknown): boolean {
  if (method !== 'get' || !response || typeof response !== 'object') return false;
  const s = response as Json;
  return s.type === 'string' && !('enum' in s) && !('const' in s) && !('format' in s);
}

interface Operation {
  name: string;
  method: string;
  path: string;
  summary: string;
  body?: unknown;
  /** A multipart/form-data body's schema (its text fields and files), instead of a JSON body. */
  multipart?: unknown;
  response: unknown;
  /** The route answers with a file (a download), not JSON. */
  file: boolean;
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
      const bodyContent = (op.requestBody as { content?: unknown } | undefined)?.content;
      out.push({
        name: operationName(method, path),
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? ''),
        body: jsonSchemaOf(bodyContent),
        multipart: multipartSchemaOf(bodyContent),
        response: successSchemaOf(responses),
        file: isFileAnswer(method, jsonSchemaOf(responses['200']?.content)),
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

/** A refused answer as an ApiError, in the one error format when its body has it. */
function refusal(status: number, text: string, retryAfterHeader: string | null): ApiError {
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  const err = (data as Partial<ApiErrorBody> | undefined)?.error;
  const retryAfter = Number(retryAfterHeader);
  return new ApiError(
    status,
    err?.code ?? 'error',
    err?.message ?? 'The request was refused.',
    err?.referenceId,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** How far an upload has got: the bytes sent so far, and the whole form's size (0 when unknown). */
export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadOptions {
  /** Called as the form's bytes are sent. */
  onProgress?: (progress: UploadProgress) => void;
  /** Aborting it cancels the upload, which then fails with the code \`aborted\`. */
  signal?: AbortSignal;
}

/** Sends a multipart/form-data form (text fields first, then files; empty and missing fields left
 * out), reporting progress as its bytes go. Cookies go with it, as it's the page's own origin. */
function upload<T>(method: string, path: string, fields: object, options: UploadOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entries = Object.entries(fields as Record<string, unknown>);
    const form = new FormData();
    for (const [name, value] of entries) {
      if (typeof value === 'string' && value !== '') form.append(name, value);
    }
    for (const [name, value] of entries) {
      if (typeof File !== 'undefined' && value instanceof File) form.append(name, value);
      else if (value instanceof Blob) form.append(name, value, 'file');
    }
    if (options.signal?.aborted) {
      reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = () => options.signal?.removeEventListener('abort', onAbort);
    xhr.open(method, path);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      options.onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 });
    };
    xhr.onload = () => {
      settle();
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(refusal(xhr.status, text, xhr.getResponseHeader('retry-after')));
        return;
      }
      try {
        resolve((text ? JSON.parse(text) : undefined) as T);
      } catch {
        reject(new ApiError(xhr.status, 'error', 'The answer could not be read.'));
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new ApiError(0, 'network_error', 'The server could not be reached. Check your connection and try again.'));
    };
    xhr.onabort = () => {
      settle();
      reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(form);
  });
}

/** A downloaded file: its bytes, its type, and the name the server gave it. */
export interface ApiFile {
  blob: Blob;
  contentType: string;
  /** From Content-Disposition, when the server named the file. */
  fileName: string | undefined;
}

/** The file name in a Content-Disposition header: the UTF-8 \`filename*\` first, then \`filename\`. */
export function fileNameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\\*\\s*=\\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      const name = decodeURIComponent(extended[1].trim());
      if (name) return name;
    } catch {
      // A malformed encoding: the plain name below.
    }
  }
  const plain = /filename\\s*=\\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim();
  return name === '' ? undefined : name;
}

async function download(method: string, path: string): Promise<ApiFile> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { accept: '*/*' } });
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached. Check your connection and try again.');
  }
  if (!res.ok) throw refusal(res.status, await res.text(), res.headers.get('retry-after'));
  return {
    blob: await res.blob(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    fileName: fileNameFromDisposition(res.headers.get('content-disposition')),
  };
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
    const responseType = op.file ? 'ApiFile' : tsType(op.response);
    types.push(`/** ${op.method} ${op.path} response. */\nexport type ${base}Response = ${responseType};`);
    const isUpload = op.body === undefined && op.multipart !== undefined;
    if (op.body !== undefined) {
      types.push(`/** ${op.method} ${op.path} request body. */\nexport type ${base}Body = ${tsType(op.body)};`);
    } else if (isUpload) {
      types.push(
        `/** ${op.method} ${op.path} request body, sent as a multipart form. */\nexport type ${base}Body = ${tsType(op.multipart)};`,
      );
    }
    const args: string[] = [];
    if (op.pathParams.length > 0) args.push(`path: { ${op.pathParams.map((p) => `${p}: string`).join('; ')} }`);
    if (op.body !== undefined || isUpload) args.push(`body: ${base}Body`);
    if (op.paged) {
      args.push('query?: ListQuery');
    } else if (op.query !== undefined) {
      types.push(`/** ${op.method} ${op.path} query parameters. */\nexport type ${base}Query = ${tsType(op.query)};`);
      args.push(`query?: ${base}Query`);
    }
    if (isUpload) args.push('options?: UploadOptions');
    const hasQuery = op.paged || op.query !== undefined;
    // Path parameters are URL-encoded into the relative address; the query is appended.
    const address =
      op.pathParams.length > 0 || hasQuery
        ? `\`${op.path.replace(/\{([A-Za-z_$][\w$]*)\}/g, (_m, p: string) => `\${encodeURIComponent(path.${p})}`)}${hasQuery ? '${queryString(query)}' : ''}\``
        : `'${op.path}'`;
    let call: string;
    if (op.body !== undefined) call = `request<${base}Response>('${op.method}', ${address}, body)`;
    else if (isUpload) call = `upload<${base}Response>('${op.method}', ${address}, body, options)`;
    else if (op.file) call = `download('${op.method}', ${address})`;
    else call = `request<${base}Response>('${op.method}', ${address})`;
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
