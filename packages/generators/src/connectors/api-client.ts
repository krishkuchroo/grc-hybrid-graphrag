// The dummy connectors' client (D11, D18, D47, D54, D57): a small client over `fetch` that talks to
// the platform's public API exactly as a customer's connector would, with one API key. It knows the
// API's addresses and answers, nothing of its internals.
// - `saveMapping`: makes sure the source's column mapping is saved. It reads the saved one first
//   (`GET /api/v1/import-mappings?source=…`); the same fields again change nothing, so a re-run adds
//   nothing (D45.5); otherwise it saves (`POST /api/v1/import-mappings`, with the saved version when
//   it replaces one).
// - `pushBatch`: `POST /api/v1/push/batches` with a JSON body `{ batchId, source, rows }`.
// - `uploadDocument`: `POST /api/v1/uploads` as a multipart form (`kind`, `label`, `source` and one
//   `file`).
// The key goes only in the `Authorization: Bearer …` header. It is never part of an error, a
// message or anything returned (D57). An error answer becomes an `ApiRequestError` carrying the
// status, the API's error code and its reference ID (D47); the API's message and the request's
// query string are left out, so nothing from the data reaches a log (D163, D164).
// A 429 is waited out for its `Retry-After` and the same request sent again, up to
// `maxRateLimitWaits` times in a row: the API's rate limits (D64) are part of its contract, and a
// connector honours them.
import { FORMAT_CONTENT_TYPES, type FileFormat, type ImportMapping, type Label, type UploadKind } from '@grc/shared';
import type { AssetRow } from './asset-rows.js';

/** Every API address starts with this (D47). */
export const API_PREFIX = '/api/v1';

/** The slice of `fetch` the client uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** The platform's address, for example `https://grc.localhost` (D60). */
  baseUrl: string;
  /** The API key (D54). Sent only in the Authorization header. */
  apiKey: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** How the client waits out a 429; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** How many 429 answers in a row one call waits out before it gives up (default 10). */
  maxRateLimitWaits?: number;
}

/** A batch for the push API. */
export interface PushBatchInput {
  batchId: string;
  source: string;
  rows: AssetRow[];
}

/** The push API's answer: a new batch (`duplicate: false`) or one the org already had. */
export interface PushBatchResult {
  batchId: string;
  importId: string | null;
  jobId: string | null;
  duplicate: boolean;
}

/** A file for the upload API. */
export interface UploadInput {
  kind: UploadKind;
  fileName: string;
  format: FileFormat;
  body: string | Uint8Array;
  /** The sensitivity label; the API's default (`internal`) when not given. */
  label?: Label;
  /** The source system, for an asset list only. */
  source?: string;
}

/** The upload API's answer: the stored document, and whether the org already had its content. */
export interface UploadResult {
  documentId: string;
  status: string;
  duplicate: boolean;
  jobId: string | null;
  importId: string | null;
}

/** A saved mapping: its ID and version, and whether this call changed it. */
export interface SavedMapping {
  id: string;
  version: number;
  changed: boolean;
}

/** What a connector does through the API. */
export interface ConnectorClient {
  saveMapping(mapping: ImportMapping): Promise<SavedMapping>;
  pushBatch(batch: PushBatchInput): Promise<PushBatchResult>;
  uploadDocument(file: UploadInput): Promise<UploadResult>;
}

/**
 * An answer the client can't use: an error answer from the API (with its code and reference ID),
 * an answer of the wrong shape (`unexpected_answer`), or no answer at all (`network_error`, with the
 * network's own error code when it gave one). Never holds the key, the API's message or a query.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    /** The HTTP status; 0 when no answer came back. */
    readonly status: number,
    readonly code: string,
    readonly referenceId: string | null,
    /** For `network_error`: the network error's code, for example ECONNREFUSED. */
    readonly causeCode: string | null = null,
  ) {
    const answered = status === 0 ? 'got no answer' : `answered ${status}`;
    const reference = referenceId === null ? '' : ` (reference ${referenceId})`;
    const cause = causeCode === null ? '' : ` [${causeCode}]`;
    super(`${method} ${path} ${answered}: ${code}${reference}${cause}`);
    this.name = 'ApiRequestError';
  }
}

const DEFAULT_RATE_LIMIT_WAITS = 10;
const MAX_WAIT_MS = 120_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** How long a 429 asks the client to wait: `Retry-After` in seconds or as a date, else 1 s. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  if (header !== null) {
    const text = header.trim();
    if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_WAIT_MS);
    const at = Date.parse(text);
    if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), MAX_WAIT_MS);
  }
  return 1000;
}

/** The base URL without trailing slashes; only http and https. Never echoes the URL's credentials. */
function cleanBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('ApiClient: baseUrl is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('ApiClient: baseUrl must be http or https');
  if (url.username !== '' || url.password !== '') throw new Error('ApiClient: baseUrl must not hold credentials');
  if (url.search !== '' || url.hash !== '') throw new Error('ApiClient: baseUrl must not have a query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function sameFields(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const defined = (o: Record<string, unknown>) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const left = defined(a);
  const right = defined(b);
  return left.length === right.length && left.every(([k, v], i) => right[i]![0] === k && right[i]![1] === v);
}

type Body = { body: string; contentType: string } | { body: FormData };

export class ApiClient implements ConnectorClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaits: number;
  // A private field, so the key never shows in a spread, JSON.stringify or console.log of the client.
  readonly #apiKey: string;

  constructor(options: ApiClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('ApiClient: an API key is needed');
    }
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey.trim();
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? realSleep;
    const waits = options.maxRateLimitWaits ?? DEFAULT_RATE_LIMIT_WAITS;
    if (!Number.isInteger(waits) || waits < 0) throw new Error('ApiClient: maxRateLimitWaits must be a whole number');
    this.maxWaits = waits;
  }

  async saveMapping(mapping: ImportMapping): Promise<SavedMapping> {
    const listPath = `${API_PREFIX}/import-mappings`;
    const query = `?source=${encodeURIComponent(mapping.source)}`;
    const list = await this.call('GET', listPath, query);
    if (!isRecord(list) || !Array.isArray(list.items)) throw this.unexpected('GET', listPath);
    const saved = (list.items as unknown[]).find((item) => isRecord(item) && item.source === mapping.source);

    if (saved !== undefined) {
      const { id, version, fields } = saved as Record<string, unknown>;
      if (typeof id !== 'string' || typeof version !== 'number' || !isRecord(fields)) {
        throw this.unexpected('GET', listPath);
      }
      if (sameFields(fields, mapping.fields)) return { id, version, changed: false };
    }
    const body = {
      source: mapping.source,
      fields: mapping.fields,
      ...(saved !== undefined ? { version: (saved as { version: number }).version } : {}),
    };
    const answer = await this.call('POST', listPath, '', () => ({
      body: JSON.stringify(body),
      contentType: 'application/json',
    }));
    if (!isRecord(answer) || typeof answer.id !== 'string' || typeof answer.version !== 'number') {
      throw this.unexpected('POST', listPath);
    }
    return { id: answer.id, version: answer.version, changed: true };
  }

  async pushBatch(batch: PushBatchInput): Promise<PushBatchResult> {
    const path = `${API_PREFIX}/push/batches`;
    const body = JSON.stringify({ batchId: batch.batchId, source: batch.source, rows: batch.rows });
    const answer = await this.call('POST', path, '', () => ({ body, contentType: 'application/json' }));
    if (!isRecord(answer)) throw this.unexpected('POST', path);
    const importId = stringOrNull(answer.importId);
    const jobId = stringOrNull(answer.jobId);
    if (
      typeof answer.batchId !== 'string' ||
      importId === undefined ||
      jobId === undefined ||
      typeof answer.duplicate !== 'boolean'
    ) {
      throw this.unexpected('POST', path);
    }
    return { batchId: answer.batchId, importId, jobId, duplicate: answer.duplicate };
  }

  async uploadDocument(file: UploadInput): Promise<UploadResult> {
    const path = `${API_PREFIX}/uploads`;
    const bytes = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : new Uint8Array(file.body);
    const answer = await this.call('POST', path, '', () => {
      const form = new FormData();
      form.append('kind', file.kind);
      if (file.label !== undefined) form.append('label', file.label);
      if (file.source !== undefined) form.append('source', file.source);
      form.append('file', new Blob([bytes], { type: FORMAT_CONTENT_TYPES[file.format] }), file.fileName);
      return { body: form };
    });
    if (!isRecord(answer) || !isRecord(answer.document) || typeof answer.duplicate !== 'boolean') {
      throw this.unexpected('POST', path);
    }
    const { id, status } = answer.document;
    if (typeof id !== 'string' || typeof status !== 'string') throw this.unexpected('POST', path);
    const jobId = stringOrNull(answer.jobId) ?? null;
    const importId = stringOrNull(answer.importId) ?? null;
    return { documentId: id, status, duplicate: answer.duplicate, jobId, importId };
  }

  private unexpected(method: string, path: string): ApiRequestError {
    return new ApiRequestError(method, path, 200, 'unexpected_answer', null);
  }

  /** Sends one request (again after each 429, up to the limit); the JSON of a 2xx answer. */
  private async call(method: 'GET' | 'POST', path: string, query: string, body?: () => Body): Promise<unknown> {
    for (let waits = 0; ; waits++) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#apiKey}`,
        accept: 'application/json',
      };
      const init: RequestInit = { method, headers };
      if (body) {
        const built = body();
        if ('contentType' in built) headers['content-type'] = built.contentType;
        init.body = built.body;
      }

      let res: Response;
      try {
        res = await this.fetch(`${this.baseUrl}${path}${query}`, init);
      } catch (err) {
        throw new ApiRequestError(method, path, 0, 'network_error', null, networkCode(err));
      }

      if (res.status === 429 && waits < this.maxWaits) {
        await discard(res);
        await this.sleep(retryAfterMs(res.headers.get('retry-after')));
        continue;
      }
      if (res.status < 200 || res.status > 299) throw await errorOf(method, path, res);
      if (res.status === 204) return null;
      const text = await res.text();
      if (text === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ApiRequestError(method, path, res.status, 'unexpected_answer', null);
      }
    }
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Nothing to keep from a body that can't be read.
  }
}

/** The network error's own code (ECONNREFUSED, a TLS code …), never its message. */
function networkCode(err: unknown): string | null {
  const codeOf = (e: unknown): string | null => {
    const code = isRecord(e) ? e.code : undefined;
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
  };
  return codeOf(err) ?? codeOf(isRecord(err) ? err.cause : undefined);
}

/** The API's one error format (D47) as an ApiRequestError: its code and reference ID only. */
async function errorOf(method: string, path: string, res: Response): Promise<ApiRequestError> {
  let code = `http_${res.status}`;
  let referenceId: string | null = null;
  try {
    const body = JSON.parse(await res.text()) as unknown;
    const error = isRecord(body) ? body.error : undefined;
    if (isRecord(error)) {
      if (typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)) code = error.code;
      if (typeof error.referenceId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(error.referenceId)) {
        referenceId = error.referenceId;
      }
    }
  } catch {
    // Not the error format: the status alone says what happened.
  }
  return new ApiRequestError(method, path, res.status, code, referenceId);
}
