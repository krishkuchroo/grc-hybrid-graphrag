// Shared set-up for the S1-006 records tests (the web records kit and the Risk register).
//
// The API is mocked at the client boundary, like `tests/auth/helpers.tsx`: `fetch` is replaced by a
// small fake of the S1-004 routes, so the generated typed client runs for real and every request it
// makes is recorded. The fake follows the real API closely enough to catch a wrong request:
// - GET /api/v1/me answers the signed-in person (M0-010).
// - GET /api/v1/people answers the org's members, paged, `{ id, name, role }` only (S1-004).
// - GET /api/v1/risks takes only the API's list parameters: page, pageSize (1 to 100), sort
//   (number | name | updatedAt | score, `-` for descending), status (active | retired | all,
//   default active), owner, label, band and q (a search on name or number). An unknown or empty
//   parameter is refused with 400, like the API's strict list query (S1-003).
// - GET /api/v1/risks/:id answers the record with its rating, or 404 `not_found`.
// - POST /api/v1/risks and PATCH /api/v1/risks/:id check the body with the shared S1-001 schemas,
//   which refuse unknown fields; PATCH compares `version` and answers 409 `stale_version` (D69).
//   A label change follows `canChangeLabel` and the clearance (D51, D198). An owner must be an org
//   member (S1-004).
// - POST /api/v1/risks/:id/retire takes `{ version }` and sets the status to retired.
// - Errors use the one D47 format with a reference ID.
//
// Contract with the app (S1-006 brief):
// - `App` from `src/app/App.tsx` is mounted at the page's address, with a live session.
// - `/risks` is the register, `/risks/new` the create form, `/risks/$id` the record page.
// - The register's filters live in the URL search params, under the API's own names
//   (`band`, `owner`, `label`, `status`, `q`), so a reload asks the API the same question.
// - The register is a table. Its column headers are buttons where they sort. Each row's number is
//   a link to the record page. The search box is a searchbox named "Search"; the other filters are
//   comboboxes named Band, Owner, Label and Status.
// - Form fields are found by their labels: Name, Impact, Likelihood, Financial exposure, Owner and
//   Label. A choice field may be a native select or a shadcn/Radix select: the helpers below handle
//   both.
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import { canChangeLabel, createSchemas, isVisible, LABELS, riskRating, updateSchemas, type Label } from '@grc/shared';
import { App } from '../../src/app/App';

configure({ asyncUtilTimeout: 3000 });

// Radix's select and dialog need a few browser calls jsdom lacks.
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] ??= () => false;
  proto['setPointerCapture'] ??= () => undefined;
  proto['releasePointerCapture'] ??= () => undefined;
  proto['scrollIntoView'] ??= () => undefined;
}
if (typeof window !== 'undefined' && window.ResizeObserver === undefined) {
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

export interface Person {
  id: string;
  name: string;
  role: string;
}

export const ORG = { id: 'org-northwind', name: 'Northwind Health' };

export const PEOPLE: Person[] = [
  { id: 'user-dana', name: 'Dana Whitfield', role: 'risk_manager' },
  { id: 'user-marcus', name: 'Marcus Bell', role: 'admin' },
  { id: 'user-omar', name: 'Omar Haddad', role: 'analyst' },
  { id: 'user-priya', name: 'Priya Raman', role: 'control_owner' },
];

export interface Me {
  id: string;
  name: string;
  role: string;
  clearance: Label;
}

export const RISK_MANAGER: Me = {
  id: 'user-dana',
  name: 'Dana Whitfield',
  role: 'risk_manager',
  clearance: 'confidential',
};
export const ADMIN: Me = { id: 'user-marcus', name: 'Marcus Bell', role: 'admin', clearance: 'restricted' };
export const ANALYST: Me = { id: 'user-omar', name: 'Omar Haddad', role: 'analyst', clearance: 'confidential' };
export const VIEWER: Me = { id: 'user-vic', name: 'Vic Lowe', role: 'viewer', clearance: 'internal' };

export interface StoredRisk {
  id: string;
  number: string;
  sourceIds: string[];
  name: string;
  label: Label;
  status: 'active' | 'retired';
  owner: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  origin: 'manual' | 'import' | 'ai';
  impact: number;
  likelihood: number;
  financialExposure: number;
}

export function riskId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function riskNumber(n: number): string {
  return `RSK${String(1000 + n).padStart(7, '0')}`;
}

/** One risk, `n` from 1. Everything not given is filled in the same way every time. */
export function makeRisk(n: number, over: Partial<StoredRisk> = {}): StoredRisk {
  return {
    id: riskId(n),
    number: riskNumber(n),
    sourceIds: [],
    name: `Risk ${String(n).padStart(3, '0')}`,
    label: 'internal',
    status: 'active',
    owner: PEOPLE[n % PEOPLE.length]!.id,
    version: 1,
    createdAt: '2026-03-14T09:00:00.000Z',
    createdBy: 'user-dana',
    updatedAt: '2026-09-18T10:15:00.000Z',
    updatedBy: 'user-dana',
    origin: 'manual',
    impact: (n % 5) + 1,
    likelihood: ((n * 2) % 5) + 1,
    financialExposure: n * 1000,
    ...over,
  };
}

/** The register's small set: named so a search on name or number finds exactly one. */
export function smallRegister(): StoredRisk[] {
  return [
    makeRisk(1, {
      name: 'Ransomware on the claims servers',
      owner: 'user-dana',
      impact: 5,
      likelihood: 4,
      label: 'confidential',
      financialExposure: 250000,
      version: 3,
    }),
    makeRisk(2, { name: 'Vendor data breach', owner: 'user-priya', impact: 3, likelihood: 3 }),
    makeRisk(3, { name: 'Laptop theft', owner: 'user-omar', impact: 1, likelihood: 2 }),
    makeRisk(4, { name: 'Payment fraud', owner: 'user-marcus', impact: 4, likelihood: 4 }),
    makeRisk(5, { name: 'Old retired risk', owner: 'user-dana', status: 'retired' }),
  ];
}

/** Enough risks that any page size up to the API's 100 needs a second page. */
export function largeRegister(): StoredRisk[] {
  return Array.from({ length: 120 }, (_, i) => makeRisk(i + 1));
}

export interface RecordedCall {
  /** What the app passed to fetch, as a string (a relative path stays relative). */
  raw: string;
  url: URL;
  method: string;
  body: unknown;
}

export interface ErrorAnswer {
  status: number;
  code: string;
  message: string;
  referenceId: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let refCounter = 0;
function apiError(status: number, code: string, message: string, referenceId?: string): Response {
  refCounter += 1;
  return json(status, { error: { code, message, referenceId: referenceId ?? `ref-rec-${refCounter}` } });
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  let text: string | undefined;
  if (init?.body !== undefined && init.body !== null) {
    text = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  } else if (typeof input === 'object' && 'clone' in input && typeof input.clone === 'function') {
    text = await (input as Request).clone().text();
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const LIST_PARAMS = new Set(['page', 'pageSize', 'sort', 'status', 'owner', 'label', 'band', 'q']);
const SORTS = ['number', 'name', 'updatedAt', 'score'];

/** One overridden answer: `match` picks the request, `answer` is sent instead of the fake's own. */
interface Override {
  method: string;
  path: RegExp;
  answer: ErrorAnswer;
  once: boolean;
}

/** A fake of the S1-004 record routes, the people list and /me. */
export class RecordsApi {
  readonly calls: RecordedCall[] = [];
  readonly risks: StoredRisk[];
  readonly people: Person[];
  me: Me;
  private overrides: Override[] = [];
  private held: { path: RegExp; release: Promise<void> } | null = null;
  private nextId = 900;

  constructor(opts: { me?: Me; risks?: StoredRisk[]; people?: Person[] } = {}) {
    this.me = opts.me ?? RISK_MANAGER;
    this.risks = (opts.risks ?? smallRegister()).map((r) => ({ ...r }));
    this.people = (opts.people ?? PEOPLE).map((p) => ({ ...p }));
  }

  /** Answers every matching request with this error (or only the next one). */
  fail(method: string, path: RegExp, answer: ErrorAnswer, once = false): void {
    this.overrides.push({ method, path, answer, once });
  }

  /** Holds matching GETs until the returned function is called (for the loading state). */
  hold(path: RegExp): () => void {
    let release!: () => void;
    this.held = { path, release: new Promise<void>((r) => (release = r)) };
    return () => {
      this.held = null;
      release();
    };
  }

  risk(id: string): StoredRisk | undefined {
    return this.risks.find((r) => r.id === id);
  }

  /** Someone else saves the record: its version goes up and its name changes. */
  changeBehindTheScenes(id: string, name: string): void {
    const r = this.risk(id)!;
    r.name = name;
    r.version += 1;
    r.updatedAt = '2026-09-28T08:00:00.000Z';
  }

  callsTo(path: string | RegExp, method = 'GET'): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method && (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname)),
    );
  }

  listCalls(): RecordedCall[] {
    return this.callsTo('/api/v1/risks', 'GET');
  }

  lastListCall(): RecordedCall {
    const calls = this.listCalls();
    expect(calls.length, 'the register asked the API for risks').toBeGreaterThan(0);
    return calls[calls.length - 1]!;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const url = new URL(raw, window.location.href);
    const body = await readBody(input, init);
    this.calls.push({ raw, url, method, body });
    const held = this.held;
    if (held && method === 'GET' && held.path.test(url.pathname)) await held.release;
    const i = this.overrides.findIndex((o) => o.method === method && o.path.test(url.pathname));
    if (i >= 0) {
      const o = this.overrides[i]!;
      if (o.once) this.overrides.splice(i, 1);
      return apiError(o.answer.status, o.answer.code, o.answer.message, o.answer.referenceId);
    }
    return this.handle(method, url, body);
  };

  private out(r: StoredRisk): Record<string, unknown> {
    return { ...r, rating: riskRating(r.impact, r.likelihood) };
  }

  private handle(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/v1/me') {
      return json(200, {
        user: { id: this.me.id, email: `${this.me.id}@northwind.test`, name: this.me.name },
        org: ORG,
        role: this.me.role,
        clearance: this.me.clearance,
        mfaEnrolled: true,
      });
    }
    if (method === 'GET' && path === '/api/v1/people') return this.listPeople(url.searchParams);
    if (path === '/api/v1/risks') {
      if (method === 'GET') return this.listRisks(url.searchParams);
      if (method === 'POST') return this.createRisk(body);
    }
    const one = /^\/api\/v1\/risks\/([^/]+)$/.exec(path);
    if (one) {
      if (method === 'GET') return this.getRisk(one[1]!);
      if (method === 'PATCH') return this.updateRisk(one[1]!, body);
    }
    const retire = /^\/api\/v1\/risks\/([^/]+)\/retire$/.exec(path);
    if (retire && method === 'POST') return this.retireRisk(retire[1]!, body);
    return apiError(404, 'not_found', 'Not found.');
  }

  private listPeople(params: URLSearchParams): Response {
    const page = Number(params.get('page') ?? '1');
    const pageSize = Number(params.get('pageSize') ?? '25');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return apiError(400, 'validation_failed', 'page or pageSize is out of range.');
    }
    const sorted = [...this.people].sort((a, b) => a.name.localeCompare(b.name));
    const items = sorted.slice((page - 1) * pageSize, page * pageSize);
    return json(200, { items, page, pageSize, total: sorted.length });
  }

  private listRisks(params: URLSearchParams): Response {
    for (const [key, value] of params) {
      if (!LIST_PARAMS.has(key)) return apiError(400, 'validation_failed', `${key}: unknown filter.`);
      if (value.trim() === '') return apiError(400, 'validation_failed', `${key}: must not be empty.`);
    }
    const page = Number(params.get('page') ?? '1');
    const pageSize = Number(params.get('pageSize') ?? '25');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return apiError(400, 'validation_failed', 'page or pageSize is out of range.');
    }
    const sort = params.get('sort') ?? 'number';
    const field = sort.replace(/^-/, '');
    if (!SORTS.includes(field)) return apiError(400, 'validation_failed', 'sort: unknown field.');
    const status = params.get('status') ?? 'active';
    if (!['active', 'retired', 'all'].includes(status)) return apiError(400, 'validation_failed', 'status: bad value.');
    const label = params.get('label');
    if (label !== null && !(LABELS as readonly string[]).includes(label)) {
      return apiError(400, 'validation_failed', 'label: bad value.');
    }
    const band = params.get('band');
    if (band !== null && !['low', 'medium', 'high', 'critical'].includes(band)) {
      return apiError(400, 'validation_failed', 'band: bad value.');
    }
    const owner = params.get('owner');
    const q = params.get('q')?.trim().toLowerCase();

    let rows = this.risks.filter((r) => isVisible(this.me.clearance, r.label));
    if (status !== 'all') rows = rows.filter((r) => r.status === status);
    if (owner !== null) rows = rows.filter((r) => r.owner === owner);
    if (label !== null) rows = rows.filter((r) => r.label === label);
    if (band !== null) rows = rows.filter((r) => riskRating(r.impact, r.likelihood).band === band);
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.number.toLowerCase().includes(q));

    const key = (r: StoredRisk): string | number =>
      field === 'score' ? r.impact * r.likelihood : (r[field as 'number' | 'name' | 'updatedAt'] as string);
    const dir = sort.startsWith('-') ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) return a.number.localeCompare(b.number);
      return (ka < kb ? -1 : 1) * dir;
    });
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => this.out(r));
    return json(200, { items, page, pageSize, total: rows.length });
  }

  private getRisk(id: string): Response {
    const r = this.risk(id);
    if (!r || !isVisible(this.me.clearance, r.label)) {
      return apiError(404, 'not_found', 'The record was not found.');
    }
    return json(200, this.out(r));
  }

  private canEdit(): boolean {
    return this.me.role === 'admin' || this.me.role === 'risk_manager';
  }

  private createRisk(body: unknown): Response {
    const parsed = createSchemas.risk.safeParse(body);
    if (!parsed.success) return apiError(400, 'validation_failed', 'The request body is not valid.');
    if (!this.canEdit()) return apiError(403, 'forbidden', 'You do not have permission to do this.');
    const label = parsed.data.label ?? 'internal';
    if (!isVisible(this.me.clearance, label)) return apiError(403, 'forbidden', 'You may not set this label.');
    const owner = parsed.data.owner ?? this.me.id;
    if (!this.people.some((p) => p.id === owner)) {
      return apiError(400, 'validation_failed', 'owner: must be a member of this organization.');
    }
    this.nextId += 1;
    const r = makeRisk(this.nextId, {
      name: parsed.data.name,
      impact: parsed.data.impact,
      likelihood: parsed.data.likelihood,
      financialExposure: parsed.data.financialExposure,
      owner,
      label,
      createdAt: '2026-09-28T09:00:00.000Z',
      updatedAt: '2026-09-28T09:00:00.000Z',
      createdBy: this.me.id,
      updatedBy: this.me.id,
    });
    this.risks.push(r);
    return json(201, this.out(r));
  }

  private updateRisk(id: string, body: unknown): Response {
    const parsed = updateSchemas.risk.safeParse(body);
    if (!parsed.success) return apiError(400, 'validation_failed', 'The request body is not valid.');
    const r = this.risk(id);
    if (!r || !isVisible(this.me.clearance, r.label)) return apiError(404, 'not_found', 'The record was not found.');
    if (!this.canEdit()) return apiError(403, 'forbidden', 'You may not do this.');
    if (parsed.data.version !== r.version) {
      return apiError(409, 'stale_version', 'This record changed since you opened it. Reload it and try again.');
    }
    const changes: Partial<typeof parsed.data> = { ...parsed.data };
    delete changes.version;
    if (changes.label !== undefined && changes.label !== r.label) {
      if (!isVisible(this.me.clearance, changes.label) || !canChangeLabel(this.me.role, r.label, changes.label)) {
        return apiError(403, 'forbidden', 'You may not set this label.');
      }
    }
    if (changes.owner !== undefined && !this.people.some((p) => p.id === changes.owner)) {
      return apiError(400, 'validation_failed', 'owner: must be a member of this organization.');
    }
    Object.assign(r, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
    r.version += 1;
    r.updatedAt = '2026-09-28T09:30:00.000Z';
    r.updatedBy = this.me.id;
    return json(200, this.out(r));
  }

  private retireRisk(id: string, body: unknown): Response {
    const version = (body as { version?: unknown } | undefined)?.version;
    const extra = body && typeof body === 'object' ? Object.keys(body).filter((k) => k !== 'version') : [];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || extra.length > 0) {
      return apiError(400, 'validation_failed', 'version: must be a whole number from 1.');
    }
    const r = this.risk(id);
    if (!r || !isVisible(this.me.clearance, r.label)) return apiError(404, 'not_found', 'The record was not found.');
    if (!this.canEdit()) return apiError(403, 'forbidden', 'You may not do this.');
    if (version !== r.version) {
      return apiError(409, 'stale_version', 'This record changed since you opened it. Reload it and try again.');
    }
    r.status = 'retired';
    r.version += 1;
    return json(200, this.out(r));
  }
}

export type User = ReturnType<typeof userEvent.setup>;

/** Installs the fake API as `fetch`, opens the app at `path` with a live session. */
export function renderApp(path: string, api = new RecordsApi()): { api: RecordsApi; user: User } {
  vi.stubGlobal('fetch', api.fetch);
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

/** Unmounts the app but keeps the address, like a page reload. */
export function reload(api: RecordsApi): { api: RecordsApi; user: User } {
  cleanup();
  const here = `${window.location.pathname}${window.location.search}`;
  return renderApp(here, api);
}

export function resetApp(): void {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
}

export async function waitForPath(path: string): Promise<void> {
  await waitFor(() => expect(window.location.pathname).toBe(path));
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The register's table, once it shows at least one data row. */
export async function findRegister(): Promise<HTMLElement> {
  return waitFor(() => {
    const table = screen.getByRole('table');
    expect(dataRows(table).length).toBeGreaterThan(0);
    return table;
  });
}

/** The table's rows that hold data cells (not the header). */
export function dataRows(table: HTMLElement): HTMLElement[] {
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0);
}

/** The number shown in each data row, in order. */
export function rowNumbers(table: HTMLElement): string[] {
  return dataRows(table).map((row) => /RSK\d{7}/.exec(row.textContent ?? '')?.[0] ?? '');
}

/** A column header by name, for example /rating/i. */
export function columnHeader(name: RegExp): HTMLElement {
  return screen.getByRole('columnheader', { name });
}

/** A form field by its label. */
export function field(label: RegExp): HTMLElement {
  return screen.getByLabelText(label);
}

function isNativeSelect(el: HTMLElement): el is HTMLSelectElement {
  return el.tagName === 'SELECT';
}

/** The visible options of a choice field (native select or Radix select), as their shown text. */
export async function optionsOf(user: User, el: HTMLElement): Promise<string[]> {
  if (isNativeSelect(el)) {
    return Array.from(el.options)
      .filter((o) => o.value !== '')
      .map((o) => (o.textContent ?? '').trim());
  }
  await user.click(el);
  const listbox = await screen.findByRole('listbox');
  const texts = within(listbox)
    .getAllByRole('option')
    .map((o) => (o.textContent ?? '').trim());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return texts;
}

/** Picks the option whose shown text matches `name` in a choice field. */
export async function choose(user: User, el: HTMLElement, name: RegExp): Promise<void> {
  if (isNativeSelect(el)) {
    const option = Array.from(el.options).find((o) => name.test((o.textContent ?? '').trim()));
    expect(option, `an option matching ${name}`).toBeTruthy();
    await user.selectOptions(el, option!);
    return;
  }
  await user.click(el);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name }));
}

/** Sets a field: types into an input, or picks the option whose text starts with `value`. */
export async function setField(user: User, label: RegExp, value: string): Promise<void> {
  const el = field(label);
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    await user.clear(el);
    if (value !== '') await user.type(el, value);
    return;
  }
  await choose(user, el, new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
}

/** The dialog on screen (Radix's AlertDialog or Dialog). */
export async function findDialog(): Promise<HTMLElement> {
  return waitFor(() => screen.queryByRole('alertdialog') ?? screen.getByRole('dialog'));
}

/** The text of the page's main area. */
export function mainText(): string {
  return screen.getByRole('main').textContent ?? '';
}
