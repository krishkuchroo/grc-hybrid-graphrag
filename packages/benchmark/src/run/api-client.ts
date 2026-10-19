// The benchmark command's client (S8-005, S8-006; D46, D47, D54, D57, D64, D163, D164): a small
// client over `fetch` that talks to the platform's public API with the run's one API key, as any
// machine would, and knows nothing of the API's internals. It reads the record lists, the
// frameworks and their requirements, and the document counts; searches (`POST /api/v1/search`);
// starts conversations and asks questions, reading the answer's event stream (`queued`, `step`,
// `sources`, `token`) to `done` or `error`; and starts, fills and finishes benchmark runs. For the
// extraction part (S8-006) it also reads, read-only, each record's links
// (`GET /api/v1/<plural>/:id/links`) and the review queue's link findings of every status with
// their decisions' outcomes (`GET /api/v1/review/findings`, `GET /api/v1/review/findings/:id`).
// For `pnpm dataset:score` (FT-001) it also reads each record's own fields (an asset's type,
// criticality and classification) and the review queue's duplicate findings of every status.
// - The key goes only in the `Authorization: Bearer …` header, and is held in a private field, so
//   it never shows in an error, a log line or a spread of the client.
// - A 429 is waited out for its `Retry-After` (at most 2 minutes a time) and the same call is sent
//   again, as often as it takes (D64: the 11th question or search in a minute waits; it never fails
//   the run). Each wait is announced through `onRateLimited` with its length only.
// - An error answer becomes an `ApiRequestError` with the method, the path (never a query string,
//   which could hold a name), the status, the API's error code and its reference ID (D47). The API's
//   message is left out, so nothing from the data reaches the output (D163, D164).
// - Every call can be stopped (`signal`, the command's Ctrl-C) and has a time limit; a stopped call
//   throws `BenchStoppedError`.
import { API_PREFIX, ApiRequestError, retryAfterMs, type FetchLike } from '@grc/generators';
import {
  EXTRACTION_LINK_TYPES,
  LINK_END_STATES,
  LINK_OUTCOME_RESULTS,
  RECORD_KINDS,
  RECORD_PATHS,
  REVIEW_FINDING_STATUSES,
  REVIEW_MAX_PAGE_SIZE,
  benchmarkResultsAddedSchema,
  benchmarkRunDetailSchema,
  chatStreamEventSchema,
  createSchemas,
  isRecordKind,
  searchAnswerSchema,
  type AddBenchmarkResultsBody,
  type BenchmarkResultsAdded,
  type BenchmarkRunDetail,
  type ChatMessage,
  type DocumentStatus,
  type FinishBenchmarkRunBody,
  type LinkEndState,
  type LinkOutcomeResult,
  type LinkType,
  type RecordKind,
  type ReviewFindingStatus,
  type SearchAnswer,
  type SearchMode,
  type StartBenchmarkRunBody,
  type UploadKind,
} from '@grc/shared';
import { z } from 'zod';

/** A call's time limit: a hybrid search or an answer can wait in Gemma's queue for a while. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
/** An answer's stream may go this long without a new event before the question fails. */
export const DEFAULT_STREAM_IDLE_MS = 15 * 60_000;
/** The most rows a list page gives (D47's paging). */
export const LIST_PAGE_SIZE = 100;

/** The command was stopped (Ctrl-C) while a call was running or waiting. */
export class BenchStoppedError extends Error {
  constructor() {
    super('stopped');
    this.name = 'BenchStoppedError';
  }
}

/** How an asked question ended: the saved message (`done`), or the stream's `error` event. */
export type AskOutcome =
  { type: 'done'; message: ChatMessage } | { type: 'error'; code: string; referenceId: string | null };

/** A record as a list gives it: the fields the benchmark reads. */
export interface ListedRecord {
  id: string;
  number: string;
  name: string;
  sourceIds: string[];
}

/** One call's options: a signal that replaces the client's own (for the last calls after a stop),
 * and a time limit. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A record as its kind's list gives it, with its status and origin (the extraction part). */
export interface OrgRecordRow {
  kind: RecordKind;
  id: string;
  number: string;
  name: string;
  sourceIds: string[];
  /** `active` or `retired`. */
  status: string;
  /** `manual`, `import` or `ai`; empty when the list gave none. */
  origin: string;
  /** The kind's own fields as the list gives them (an asset's `assetType`, `criticality` and
   * `dataClassification` …); only the text and number ones. */
  fields?: Record<string, string | number>;
}

/** A duplicate finding, as the review queue's list gives it: the pair's two records, by ID (null
 * for one the reader can't see). */
export interface DuplicateFindingRow {
  id: string;
  status: ReviewFindingStatus;
  recordKind: RecordKind;
  keptId: string | null;
  otherId: string | null;
}

/** One of a record's links, as `GET /api/v1/<plural>/:id/links` gives it: its type, whether the
 * record is its start (`out`) or its end (`in`), the other end, and where it came from. */
export interface RecordLinkRow {
  type: string;
  direction: 'out' | 'in';
  other: { id: string; kind: RecordKind; number: string; name: string; status: string };
  /** `manual`, `import` or `ai`; empty when the link has none. */
  origin: string;
}

/** One end of a link finding, as the review queue's list gives it: its kind and name as Gemma
 * wrote them, its state, and the matched record's ID for a `matched` end. */
export interface LinkFindingEnd {
  kind: RecordKind;
  name: string;
  state: LinkEndState;
  recordId: string | null;
}

/** A link finding, as the review queue's list gives it. */
export interface LinkFindingRow {
  id: string;
  status: ReviewFindingStatus;
  type: LinkType;
  from: LinkFindingEnd;
  to: LinkFindingEnd;
}

/** What a link finding's decision wrote: the link between the two records settled on, made then
 * (`created`) or already there (`exists`), and whether it has been removed since. */
export interface LinkFindingOutcome {
  result: LinkOutcomeResult;
  type: LinkType;
  fromId: string;
  toId: string;
  removed: boolean;
}

/** What the benchmark run reads and writes through the API. */
export interface BenchApi {
  listRecords(path: string, query?: Record<string, string>, options?: CallOptions): Promise<ListedRecord[]>;
  frameworkIds(options?: CallOptions): Promise<ListedRecord[]>;
  documentCount(kind: UploadKind, status: DocumentStatus, options?: CallOptions): Promise<number>;
  search(query: string, mode: SearchMode, options?: CallOptions): Promise<SearchAnswer>;
  startConversation(options?: CallOptions): Promise<string>;
  ask(conversationId: string, question: string, mode: SearchMode, options?: CallOptions): Promise<AskOutcome>;
  startRun(body: StartBenchmarkRunBody, options?: CallOptions): Promise<BenchmarkRunDetail>;
  addResults(runId: string, body: AddBenchmarkResultsBody, options?: CallOptions): Promise<BenchmarkResultsAdded>;
  finishRun(runId: string, body: FinishBenchmarkRunBody, options?: CallOptions): Promise<BenchmarkRunDetail>;
}

export interface BenchApiClientOptions {
  /** The platform's address, for example `https://grc.localhost` (D60), already checked. */
  baseUrl: string;
  /** The run's API key (D54). Sent only in the Authorization header. */
  apiKey: string;
  /** Stops every call (the command's Ctrl-C). */
  signal?: AbortSignal;
  fetch?: FetchLike;
  /** Waits out a 429; ends early (rejecting) when the signal is aborted. Defaults to a timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told how long each 429 wait is, in milliseconds. */
  onRateLimited?: (waitMs: number) => void;
  requestTimeoutMs?: number;
  streamIdleMs?: number;
}

/** A timer that ends early when the signal is aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BenchStoppedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BenchStoppedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const listedRecordSchema = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  name: z.string(),
  sourceIds: z.array(z.string()).optional(),
});

const pageSchema = z.object({
  items: z.array(z.unknown()),
  total: z.int().min(0),
});

const frameworksSchema = z.object({ items: z.array(z.unknown()) });

const orgRecordRowSchema = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  name: z.string(),
  sourceIds: z.array(z.string()).optional(),
  status: z.string(),
  origin: z.string().nullable().optional(),
});

/** Each kind's own fields: its create schema's, but the name, owner and label. */
const OWN_FIELDS: Readonly<Record<RecordKind, readonly string[]>> = Object.fromEntries(
  RECORD_KINDS.map((kind) => [
    kind,
    Object.keys(createSchemas[kind].shape).filter((f) => !['name', 'owner', 'label'].includes(f)),
  ]),
) as unknown as Record<RecordKind, readonly string[]>;

/** The text and number values of a list item's own fields. */
function ownFieldsOf(kind: RecordKind, item: unknown): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  if (typeof item !== 'object' || item === null) return fields;
  for (const field of OWN_FIELDS[kind]) {
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) fields[field] = value;
  }
  return fields;
}

const recordLinksSchema = z.object({ items: z.array(z.unknown()) });

const recordLinkRowSchema = z.object({
  type: z.string(),
  direction: z.enum(['out', 'in']),
  other: z.object({
    id: z.string().min(1),
    kind: z.string(),
    number: z.string(),
    name: z.string(),
    status: z.string(),
  }),
  origin: z.string().nullable().optional(),
});

const linkFindingEndSchema = z.object({
  kind: z.string(),
  name: z.string(),
  state: z.enum(LINK_END_STATES),
  record: z.object({ recordId: z.string().min(1) }).optional(),
});

const linkFindingRowSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('link'),
  status: z.enum(REVIEW_FINDING_STATUSES),
  summary: z.object({ type: z.enum(EXTRACTION_LINK_TYPES), from: linkFindingEndSchema, to: linkFindingEndSchema }),
});

const shownOrHiddenSchema = z.union([z.object({ recordId: z.string().min(1) }), z.object({ hidden: z.literal(true) })]);

const duplicateFindingRowSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('duplicate'),
  status: z.enum(REVIEW_FINDING_STATUSES),
  summary: z.object({ recordKind: z.string(), kept: shownOrHiddenSchema, other: shownOrHiddenSchema }),
});

const linkFindingDetailSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('link'),
  outcome: z
    .object({
      result: z.enum(LINK_OUTCOME_RESULTS),
      type: z.enum(EXTRACTION_LINK_TYPES),
      fromId: z.string().min(1),
      toId: z.string().min(1),
      removed: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
const conversationSchema = z.object({ id: z.uuid() });

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The network error's own code (ECONNREFUSED, a TLS code …), never its message. */
function networkCode(err: unknown): string | null {
  const codeOf = (e: unknown): string | null => {
    const code = isRecord(e) ? e['code'] : undefined;
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
  };
  return codeOf(err) ?? codeOf(isRecord(err) ? err['cause'] : undefined);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Nothing to keep from a body that can't be read.
  }
}

/** The API's one error format (D47) as an ApiRequestError: its code and reference ID only. */
async function errorOf(method: string, path: string, res: Response): Promise<ApiRequestError> {
  let code = `http_${res.status}`;
  let referenceId: string | null = null;
  try {
    const body = JSON.parse(await res.text()) as unknown;
    const error = isRecord(body) ? body['error'] : undefined;
    if (isRecord(error)) {
      if (typeof error['code'] === 'string' && SAFE_CODE.test(error['code'])) code = error['code'];
      if (typeof error['referenceId'] === 'string' && SAFE_REFERENCE.test(error['referenceId'])) {
        referenceId = error['referenceId'];
      }
    }
  } catch {
    // Not the error format: the status alone says what happened.
  }
  return new ApiRequestError(method, path, res.status, code, referenceId);
}

/** The parts of one `text/event-stream` frame: its `event` name and its `data` text. */
interface Frame {
  event: string | null;
  data: string;
}

function parseFrame(text: string): Frame | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  return data.length === 0 && event === null ? null : { event, data: data.join('\n') };
}

type Body = { json: unknown } | null;

export class BenchApiClient implements BenchApi {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly stopSignal: AbortSignal | undefined;
  private readonly onRateLimited: ((waitMs: number) => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleMs: number;
  // A private field, so the key never shows in a spread, JSON.stringify or console.log of the client.
  readonly #apiKey: string;

  constructor(options: BenchApiClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('BenchApiClient: an API key is needed');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey.trim();
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? abortableSleep;
    this.stopSignal = options.signal;
    this.onRateLimited = options.onRateLimited;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamIdleMs = options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
  }

  /** Every row of a paged list (`GET /api/v1/<path>`), page by page. */
  async listRecords(path: string, query: Record<string, string> = {}, options?: CallOptions): Promise<ListedRecord[]> {
    const fullPath = `${API_PREFIX}${path}`;
    return this.paged(fullPath, query, options, LIST_PAGE_SIZE, (item) => [this.listed('GET', fullPath, item)]);
  }

  /** Every record of a kind, retired ones too, with its status and origin (`GET /api/v1/<plural>`). */
  async recordRows(kind: RecordKind, options?: CallOptions): Promise<OrgRecordRow[]> {
    const path = `${API_PREFIX}/${RECORD_PATHS[kind]}`;
    return this.paged(path, { status: 'all' }, options, LIST_PAGE_SIZE, (item) => {
      const row = orgRecordRowSchema.safeParse(item);
      if (!row.success) throw this.unexpected('GET', path);
      const { id, number, name, sourceIds, status, origin } = row.data;
      const fields = ownFieldsOf(kind, item);
      return [{ kind, id, number, name, sourceIds: sourceIds ?? [], status, origin: origin ?? '', fields }];
    });
  }

  /** A record's links whose other end is one of the five record kinds
   * (`GET /api/v1/<plural>/:id/links`). */
  async recordLinks(kind: RecordKind, id: string, options?: CallOptions): Promise<RecordLinkRow[]> {
    const path = `${API_PREFIX}/${RECORD_PATHS[kind]}/${encodeURIComponent(id)}/links`;
    const answer = recordLinksSchema.safeParse(await this.json('GET', path, '', null, options));
    if (!answer.success) throw this.unexpected('GET', path);
    return answer.data.items.flatMap((item): RecordLinkRow[] => {
      const row = recordLinkRowSchema.safeParse(item);
      if (!row.success) throw this.unexpected('GET', path);
      const { type, direction, other, origin } = row.data;
      // A link to another kind of node (a framework, evidence …) is not one the extraction makes.
      if (!isRecordKind(other.kind)) return [];
      return [{ type, direction, other: { ...other, kind: other.kind }, origin: origin ?? '' }];
    });
  }

  /** Every link finding in the review queue, of every status, oldest first
   * (`GET /api/v1/review/findings`). */
  async linkFindings(options?: CallOptions): Promise<LinkFindingRow[]> {
    const path = `${API_PREFIX}/review/findings`;
    const query = { kind: 'link', status: REVIEW_FINDING_STATUSES.join(','), sort: 'oldest' };
    const endOf = (end: z.infer<typeof linkFindingEndSchema>): LinkFindingEnd => {
      if (!isRecordKind(end.kind)) throw this.unexpected('GET', path);
      const recordId = end.state === 'matched' ? (end.record?.recordId ?? null) : null;
      return { kind: end.kind, name: end.name, state: end.state, recordId };
    };
    return this.paged(path, query, options, REVIEW_MAX_PAGE_SIZE, (item) => {
      const row = linkFindingRowSchema.safeParse(item);
      if (!row.success) throw this.unexpected('GET', path);
      const { id, status, summary } = row.data;
      return [{ id, status, type: summary.type, from: endOf(summary.from), to: endOf(summary.to) }];
    });
  }

  /** Every duplicate finding in the review queue, of every status, oldest first
   * (`GET /api/v1/review/findings?kind=duplicate`). */
  async duplicateFindings(options?: CallOptions): Promise<DuplicateFindingRow[]> {
    const path = `${API_PREFIX}/review/findings`;
    const query = { kind: 'duplicate', status: REVIEW_FINDING_STATUSES.join(','), sort: 'oldest' };
    const idOf = (end: z.infer<typeof shownOrHiddenSchema>): string | null => ('recordId' in end ? end.recordId : null);
    return this.paged(path, query, options, REVIEW_MAX_PAGE_SIZE, (item) => {
      const row = duplicateFindingRowSchema.safeParse(item);
      if (!row.success || !isRecordKind(row.data.summary.recordKind)) throw this.unexpected('GET', path);
      const { id, status, summary } = row.data;
      return [
        {
          id,
          status,
          recordKind: summary.recordKind as RecordKind,
          keptId: idOf(summary.kept),
          otherId: idOf(summary.other),
        },
      ];
    });
  }

  /** What a link finding's decision wrote, or null when it has no outcome
   * (`GET /api/v1/review/findings/:id`). */
  async linkFindingOutcome(id: string, options?: CallOptions): Promise<LinkFindingOutcome | null> {
    const path = `${API_PREFIX}/review/findings/${encodeURIComponent(id)}`;
    const answer = linkFindingDetailSchema.safeParse(await this.json('GET', path, '', null, options));
    if (!answer.success || answer.data.id !== id) throw this.unexpected('GET', path);
    const outcome = answer.data.outcome ?? null;
    if (outcome === null) return null;
    return {
      result: outcome.result,
      type: outcome.type,
      fromId: outcome.fromId,
      toId: outcome.toId,
      removed: outcome.removed !== undefined && outcome.removed !== null,
    };
  }

  /** The org's active frameworks (`GET /api/v1/frameworks`), each with its ID, number and name. */
  async frameworkIds(options?: CallOptions): Promise<ListedRecord[]> {
    const path = `${API_PREFIX}/frameworks`;
    const answer = frameworksSchema.safeParse(await this.json('GET', path, '', null, options));
    if (!answer.success) throw this.unexpected('GET', path);
    return answer.data.items.map((item) => this.listed('GET', path, item));
  }

  /** How many of the org's documents of a kind have a status (`GET /api/v1/documents`). */
  async documentCount(kind: UploadKind, status: DocumentStatus, options?: CallOptions): Promise<number> {
    const path = `${API_PREFIX}/documents`;
    const params = new URLSearchParams({ kind, status, page: '1', pageSize: '1' });
    const answer = pageSchema.safeParse(await this.json('GET', path, `?${params.toString()}`, null, options));
    if (!answer.success) throw this.unexpected('GET', path);
    return answer.data.total;
  }

  /** One search (`POST /api/v1/search`) in the mode given. */
  async search(query: string, mode: SearchMode, options?: CallOptions): Promise<SearchAnswer> {
    const path = `${API_PREFIX}/search`;
    const answer = searchAnswerSchema.safeParse(await this.json('POST', path, '', { json: { query, mode } }, options));
    if (!answer.success) throw this.unexpected('POST', path);
    return answer.data;
  }

  /** A new, empty conversation (`POST /api/v1/chat/conversations`); its ID. */
  async startConversation(options?: CallOptions): Promise<string> {
    const path = `${API_PREFIX}/chat/conversations`;
    const answer = conversationSchema.safeParse(await this.json('POST', path, '', { json: {} }, options));
    if (!answer.success) throw this.unexpected('POST', path);
    return answer.data.id;
  }

  /** Asks a question in the mode given and reads the answer's stream to `done` or `error`. */
  async ask(conversationId: string, question: string, mode: SearchMode, options?: CallOptions): Promise<AskOutcome> {
    const path = `${API_PREFIX}/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
    const { res, signal, done } = await this.send('POST', path, '', { json: { question, mode } }, options, {
      accept: 'text/event-stream',
      keepOpen: true,
    });
    try {
      if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
        await discard(res);
        throw this.unexpected('POST', path);
      }
      return await this.readStream('POST', path, res, signal);
    } finally {
      done();
    }
  }

  async startRun(body: StartBenchmarkRunBody, options?: CallOptions): Promise<BenchmarkRunDetail> {
    const path = `${API_PREFIX}/benchmark/runs`;
    const answer = benchmarkRunDetailSchema.safeParse(await this.json('POST', path, '', { json: body }, options));
    if (!answer.success) throw this.unexpected('POST', path);
    return answer.data;
  }

  async addResults(
    runId: string,
    body: AddBenchmarkResultsBody,
    options?: CallOptions,
  ): Promise<BenchmarkResultsAdded> {
    const path = `${API_PREFIX}/benchmark/runs/${encodeURIComponent(runId)}/results`;
    const answer = benchmarkResultsAddedSchema.safeParse(await this.json('POST', path, '', { json: body }, options));
    if (!answer.success) throw this.unexpected('POST', path);
    return answer.data;
  }

  async finishRun(runId: string, body: FinishBenchmarkRunBody, options?: CallOptions): Promise<BenchmarkRunDetail> {
    const path = `${API_PREFIX}/benchmark/runs/${encodeURIComponent(runId)}/finish`;
    const answer = benchmarkRunDetailSchema.safeParse(await this.json('POST', path, '', { json: body }, options));
    if (!answer.success) throw this.unexpected('POST', path);
    return answer.data;
  }

  /** Every item of a paged list (D47's paging), page by page, each made into rows by `rows`. */
  private async paged<T>(
    path: string,
    query: Record<string, string>,
    options: CallOptions | undefined,
    pageSize: number,
    rows: (item: unknown) => T[],
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ ...query, page: String(page), pageSize: String(pageSize) });
      const answer = pageSchema.safeParse(await this.json('GET', path, `?${params.toString()}`, null, options));
      if (!answer.success) throw this.unexpected('GET', path);
      for (const item of answer.data.items) out.push(...rows(item));
      const pages = Math.ceil(answer.data.total / pageSize);
      if (answer.data.items.length === 0 || page >= pages) return out;
    }
  }

  private listed(method: string, path: string, item: unknown): ListedRecord {
    const parsed = listedRecordSchema.safeParse(item);
    if (!parsed.success) throw this.unexpected(method, path);
    const { id, number, name, sourceIds } = parsed.data;
    return { id, number, name, sourceIds: sourceIds ?? [] };
  }

  private unexpected(method: string, path: string): ApiRequestError {
    return new ApiRequestError(method, path, 200, 'unexpected_answer', null);
  }

  /** Sends one call and reads its JSON answer (null for an empty one). */
  private async json(
    method: 'GET' | 'POST',
    path: string,
    query: string,
    body: Body,
    options: CallOptions | undefined,
  ): Promise<unknown> {
    const { res, done, timedOut } = await this.send(method, path, query, body, options, {
      accept: 'application/json',
      keepOpen: false,
    });
    try {
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        throw this.failure(method, path, err, options, timedOut());
      }
      if (text === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw this.unexpected(method, path);
      }
    } finally {
      done();
    }
  }

  /** The signal a call runs under: the call's own (or the client's stop signal) and its time limit. */
  private callSignal(options: CallOptions | undefined): {
    signal: AbortSignal;
    stop: AbortSignal | undefined;
    timeout: AbortController;
    done: () => void;
  } {
    const stop = options?.signal ?? this.stopSignal;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options?.timeoutMs ?? this.requestTimeoutMs);
    const signal = stop ? AbortSignal.any([stop, timeout.signal]) : timeout.signal;
    return { signal, stop, timeout, done: () => clearTimeout(timer) };
  }

  /** What a failed fetch or read becomes: stopped, timed out, or a network error with its code. */
  private failure(
    method: string,
    path: string,
    err: unknown,
    options: CallOptions | undefined,
    timedOut = false,
  ): Error {
    const stop = options?.signal ?? this.stopSignal;
    if (stop?.aborted && options?.signal === undefined) return new BenchStoppedError();
    if (timedOut || (stop?.aborted ?? false)) return new ApiRequestError(method, path, 0, 'timed_out', null);
    if (err instanceof ApiRequestError || err instanceof BenchStoppedError) return err;
    return new ApiRequestError(method, path, 0, 'network_error', null, networkCode(err));
  }

  /**
   * Sends one call (again after each 429) and gives back a 2xx answer, unread. `keepOpen` leaves the
   * time limit off once the answer has started (a stream has its own idle limit); `done` clears the
   * limit's timer.
   */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    query: string,
    body: Body,
    options: CallOptions | undefined,
    how: { accept: string; keepOpen: boolean },
  ): Promise<{ res: Response; signal: AbortSignal; done: () => void; timedOut: () => boolean }> {
    for (;;) {
      const call = this.callSignal(options);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#apiKey}`,
        accept: how.accept,
      };
      const init: RequestInit = { method, headers, signal: call.signal };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body.json);
      }

      let res: Response;
      try {
        res = await this.fetch(`${this.baseUrl}${path}${query}`, init);
      } catch (err) {
        const timedOut = call.timeout.signal.aborted;
        call.done();
        throw this.failure(method, path, err, options, timedOut);
      }

      if (res.status === 429) {
        call.done();
        await discard(res);
        const waitMs = retryAfterMs(res.headers.get('retry-after'));
        this.onRateLimited?.(waitMs);
        try {
          await this.sleep(waitMs, options?.signal ?? this.stopSignal ?? new AbortController().signal);
        } catch (err) {
          throw this.failure(method, path, err, options);
        }
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        const error = await errorOf(method, path, res);
        call.done();
        throw error;
      }
      if (how.keepOpen) {
        // The stream has its own idle limit from here on; the stop signal still applies.
        call.done();
        const stop = options?.signal ?? this.stopSignal;
        return { res, signal: stop ?? new AbortController().signal, done: () => undefined, timedOut: () => false };
      }
      return { res, signal: call.signal, done: call.done, timedOut: () => call.timeout.signal.aborted };
    }
  }

  /** Reads an answer's event stream to its `done` or `error` event. */
  private async readStream(method: string, path: string, res: Response, stop: AbortSignal): Promise<AskOutcome> {
    if (res.body === null) throw new ApiRequestError(method, path, res.status, 'stream_ended', null);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onStop = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    stop.addEventListener('abort', onStop, { once: true });
    let timedOut = false;
    try {
      for (;;) {
        idle = setTimeout(() => {
          timedOut = true;
          void reader.cancel().catch(() => undefined);
        }, this.streamIdleMs);
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (stop.aborted) throw new BenchStoppedError();
          throw new ApiRequestError(method, path, res.status, timedOut ? 'stream_timed_out' : 'stream_broken', null);
        } finally {
          clearTimeout(idle);
        }
        if (stop.aborted) throw new BenchStoppedError();
        if (timedOut) throw new ApiRequestError(method, path, res.status, 'stream_timed_out', null);
        if (chunk.done) {
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        buffer = buffer.replace(/\r\n?/g, '\n');
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const frame = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          const outcome = frame === null ? null : this.outcomeOf(method, path, frame);
          if (outcome !== null) return outcome;
        }
        if (chunk.done) {
          const frame = buffer.trim() === '' ? null : parseFrame(buffer);
          const outcome = frame === null ? null : this.outcomeOf(method, path, frame);
          if (outcome !== null) return outcome;
          throw new ApiRequestError(method, path, res.status, 'stream_ended', null);
        }
      }
    } finally {
      stop.removeEventListener('abort', onStop);
      void reader.cancel().catch(() => undefined);
    }
  }

  /** The frame's outcome when it is `done` or `error`; null for the events before them. A `done` or
   * `error` frame that doesn't fit its schema is an unexpected answer. */
  private outcomeOf(method: string, path: string, frame: Frame): AskOutcome | null {
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      value = undefined;
    }
    const name = isRecord(value) && typeof value['event'] === 'string' ? value['event'] : frame.event;
    if (name !== 'done' && name !== 'error') return null;
    const parsed = chatStreamEventSchema.safeParse(value);
    if (!parsed.success) throw this.unexpected(method, path);
    const event = parsed.data;
    if (event.event === 'done') return { type: 'done', message: event.message };
    if (event.event === 'error') {
      return {
        type: 'error',
        code: SAFE_CODE.test(event.code) ? event.code : 'chat_error',
        referenceId: SAFE_REFERENCE.test(event.referenceId) ? event.referenceId : null,
      };
    }
    return null;
  }
}
