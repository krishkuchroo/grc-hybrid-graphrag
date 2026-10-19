// The dataset loader's client for records and framework mappings (FT-001; D37, D47, D54, D57, D64,
// D163, D164, D237): what `pnpm dataset:load --mode full` sends through the public API besides the
// connectors' asset lists and documents, with the run's one API key, as any machine would.
// - `recordRows`: every record of a kind, retired ones too (`GET /api/v1/<plural>?status=all`), paged.
// - `createRecord`: `POST /api/v1/<plural>` with the create schema's body.
// - `frameworks`: the org's frameworks (`GET /api/v1/frameworks`).
// - `requirementsByCode`: a framework's requirements whose code is exactly the one given, found
//   through `GET /api/v1/frameworks/:id/requirements?q=<code>`, page by page.
// - `addMapping`: `POST /api/v1/mappings`; a 409 `link_exists` answer is `exists`, not an error.
// The key goes only in the `Authorization: Bearer …` header and is held in a private field, so it
// never shows in an error, a log line or a spread of the client. A 429 is waited out for its
// `Retry-After` and the same request sent again, up to `maxRateLimitWaits` times in a row (D64). An
// error answer becomes an `ApiRequestError` with the method, the path (never a query string), the
// status, the API's code and its reference ID; the API's message is left out (D163, D164).
import { RECORD_PATHS, type RecordKind } from '@grc/shared';
import { API_PREFIX, ApiRequestError, retryAfterMs, type FetchLike } from '../connectors/index.js';

/** The most rows a list page gives (D47's paging). */
export const DATASET_PAGE_SIZE = 100;
const DEFAULT_RATE_LIMIT_WAITS = 10;

/** A record as its kind's list gives it: the fields the loader reads. */
export interface DatasetRecordRow {
  id: string;
  number: string;
  name: string;
  /** `active` or `retired`. */
  status: string;
}

export interface DatasetFramework {
  id: string;
  /** The catalog key, for example `nist_800_53`. */
  key: string;
}

export interface DatasetRequirement {
  id: string;
  code: string;
  status: string;
}

/** What the loader's records and mappings steps do through the API. */
export interface DatasetApi {
  recordRows(kind: RecordKind): Promise<DatasetRecordRow[]>;
  createRecord(kind: RecordKind, body: Record<string, unknown>): Promise<DatasetRecordRow>;
  frameworks(): Promise<DatasetFramework[]>;
  requirementsByCode(frameworkId: string, code: string): Promise<DatasetRequirement[]>;
  addMapping(controlId: string, requirementId: string): Promise<'added' | 'exists'>;
}

export interface DatasetApiClientOptions {
  /** The platform's address, for example `https://grc.localhost` (D60). */
  baseUrl: string;
  /** The run's API key (D54). Sent only in the Authorization header. */
  apiKey: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** How many 429 answers in a row one call waits out before it gives up (default 10). */
  maxRateLimitWaits?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The network error's own code (ECONNREFUSED, a TLS code …), never its message. */
function networkCode(err: unknown): string | null {
  const codeOf = (e: unknown): string | null => {
    const code = isRecord(e) ? e['code'] : undefined;
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
  };
  return codeOf(err) ?? codeOf(isRecord(err) ? err['cause'] : undefined);
}

/** The API's one error format (D47) as an ApiRequestError: its code and reference ID only. */
async function errorOf(method: string, path: string, res: Response): Promise<ApiRequestError> {
  let code = `http_${res.status}`;
  let referenceId: string | null = null;
  try {
    const body = JSON.parse(await res.text()) as unknown;
    const error = isRecord(body) ? body['error'] : undefined;
    if (isRecord(error)) {
      if (text(error['code']) && /^[a-z0-9_]{1,64}$/.test(error['code'])) code = error['code'];
      if (text(error['referenceId']) && /^[A-Za-z0-9-]{1,64}$/.test(error['referenceId'])) {
        referenceId = error['referenceId'];
      }
    }
  } catch {
    // Not the error format: the status alone says what happened.
  }
  return new ApiRequestError(method, path, res.status, code, referenceId);
}

/** The base URL without trailing slashes; only http and https, no credentials, query or fragment. */
function cleanBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('DatasetApiClient: baseUrl is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DatasetApiClient: baseUrl must be http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('DatasetApiClient: baseUrl must hold no credentials, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class DatasetApiClient implements DatasetApi {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaits: number;
  // A private field, so the key never shows in a spread, JSON.stringify or console.log of the client.
  readonly #apiKey: string;

  constructor(options: DatasetApiClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('DatasetApiClient: an API key is needed');
    }
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey.trim();
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? realSleep;
    const waits = options.maxRateLimitWaits ?? DEFAULT_RATE_LIMIT_WAITS;
    if (!Number.isInteger(waits) || waits < 0) {
      throw new Error('DatasetApiClient: maxRateLimitWaits must be a whole number');
    }
    this.maxWaits = waits;
  }

  async recordRows(kind: RecordKind): Promise<DatasetRecordRow[]> {
    const path = `${API_PREFIX}/${RECORD_PATHS[kind]}`;
    return this.paged(path, { status: 'all' }, (item) => [this.recordRow('GET', path, item)]);
  }

  async createRecord(kind: RecordKind, body: Record<string, unknown>): Promise<DatasetRecordRow> {
    const path = `${API_PREFIX}/${RECORD_PATHS[kind]}`;
    const answer = await this.call('POST', path, '', body);
    return this.recordRow('POST', path, answer.body);
  }

  async frameworks(): Promise<DatasetFramework[]> {
    const path = `${API_PREFIX}/frameworks`;
    const answer = await this.call('GET', path, '');
    const items = isRecord(answer.body) ? answer.body['items'] : undefined;
    if (!Array.isArray(items)) throw this.unexpected('GET', path);
    return items.map((item: unknown) => {
      if (!isRecord(item) || !text(item['id']) || !text(item['key'])) throw this.unexpected('GET', path);
      return { id: item['id'], key: item['key'] };
    });
  }

  async requirementsByCode(frameworkId: string, code: string): Promise<DatasetRequirement[]> {
    const path = `${API_PREFIX}/frameworks/${encodeURIComponent(frameworkId)}/requirements`;
    const rows = await this.paged(path, { q: code }, (item) => {
      if (!isRecord(item) || !text(item['id']) || !text(item['code']) || !text(item['status'])) {
        throw this.unexpected('GET', path);
      }
      return [{ id: item['id'], code: item['code'], status: item['status'] }];
    });
    return rows.filter((row) => row.code === code);
  }

  async addMapping(controlId: string, requirementId: string): Promise<'added' | 'exists'> {
    const path = `${API_PREFIX}/mappings`;
    try {
      await this.call('POST', path, '', { controlId, requirementId });
      return 'added';
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409 && err.code === 'link_exists') return 'exists';
      throw err;
    }
  }

  private recordRow(method: string, path: string, item: unknown): DatasetRecordRow {
    if (!isRecord(item)) throw this.unexpected(method, path);
    const { id, number, name, status } = item;
    if (!text(id) || id === '' || !text(number) || !text(name) || !text(status)) throw this.unexpected(method, path);
    return { id, number, name, status };
  }

  /** Every item of a paged list (D47's paging), page by page, each made into rows by `rows`. */
  private async paged<T>(path: string, query: Record<string, string>, rows: (item: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ ...query, page: String(page), pageSize: String(DATASET_PAGE_SIZE) });
      const answer = await this.call('GET', path, `?${params.toString()}`);
      const body = answer.body;
      if (!isRecord(body) || !Array.isArray(body['items']) || typeof body['total'] !== 'number') {
        throw this.unexpected('GET', path);
      }
      const items = body['items'] as unknown[];
      for (const item of items) out.push(...rows(item));
      if (items.length === 0 || page >= Math.ceil(body['total'] / DATASET_PAGE_SIZE)) return out;
    }
  }

  private unexpected(method: string, path: string): ApiRequestError {
    return new ApiRequestError(method, path, 200, 'unexpected_answer', null);
  }

  /** Sends one request (again after each 429, up to the limit); the JSON of a 2xx answer. */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    query: string,
    json?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    for (let waits = 0; ; waits++) {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json' };
      const init: RequestInit = { method, headers };
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      let res: Response;
      try {
        res = await this.fetch(`${this.baseUrl}${path}${query}`, init);
      } catch (err) {
        throw new ApiRequestError(method, path, 0, 'network_error', null, networkCode(err));
      }
      if (res.status === 429 && waits < this.maxWaits) {
        try {
          await res.arrayBuffer();
        } catch {
          // Nothing to keep from a body that can't be read.
        }
        await this.sleep(retryAfterMs(res.headers.get('retry-after')));
        continue;
      }
      if (res.status < 200 || res.status > 299) throw await errorOf(method, path, res);
      const body = res.status === 204 ? '' : await res.text();
      if (body === '') return { status: res.status, body: null };
      try {
        return { status: res.status, body: JSON.parse(body) as unknown };
      } catch {
        throw new ApiRequestError(method, path, res.status, 'unexpected_answer', null);
      }
    }
  }
}
