// Shared set-up for the S1-008 tests: related records on every record page, and the "Add link"
// dialog.
//
// The API is mocked at the client boundary, like `tests/records/helpers.tsx` and
// `tests/record-screens/helpers.tsx`: `fetch` is replaced by a fake, so the generated typed client
// runs for real and every request is recorded. The fake follows the real API (S1-004, S1-005, the S1
// shared notes):
// - GET /api/v1/me and GET /api/v1/people as before.
// - GET /api/v1/<plural> and GET /api/v1/<plural>/:id for all five kinds, with the D50 role table
//   (`ROLE_TABLE`), `edit_own` meaning "only their own controls", and the D51 labels. A kind the role
//   can never view answers 403 on its list; a record the caller can't see answers 404 `not_found`.
//   Lists take only the API's parameters (page, pageSize, sort, status, owner, label, q, plus the
//   kind's own filters); `q` searches name or number. An unknown or empty parameter is 400.
// - GET /api/v1/<plural>/:id/links (S1-005): 404 when the record itself is hidden; otherwise
//   `{ items: [{ type, direction, other: { id, kind, number, name, label, status }, origin,
//   createdAt, createdBy }] }`, holding only the links whose other end the caller can see (D51: a
//   link is visible only if both ends are). Nothing tells how many were left out.
// - POST /api/v1/links (S1-005) with `{ type, fromId, toId }` only: 404 `not_found` when either end
//   is missing or hidden, 400 `validation_failed` for a link to itself, 400 `link_not_allowed` when
//   `isAllowedLink` fails, 403 `forbidden` when `canLinkRecords` fails (D200), 409 `link_exists`
//   for the same link twice, else 201 with the link. The messages are the API's own.
// - POST /api/v1/links/remove (S1-011, D201, D207) with `{ type, fromId, toId }` only: 400
//   `validation_failed` for any other body; 404 `not_found` when either end is missing or hidden or
//   there is no such link; 403 `forbidden` when `canLinkRecords` fails; 409 `ai_link_review_only`
//   when `isRemovableLinkOrigin` fails; else 200 with `{ type, fromId, toId }` and the link is gone.
//
// Contract with the app (S1-008 brief):
// - Each record page (`/risks/$id`, `/controls/$id`, `/policies/$id`, `/assets/$id`,
//   `/incidents/$id`) shows its related records in groups. Each group is a region (a `<section>`)
//   named by its plain title, for example "Controls that treat this risk".
// - On an asset page, HOSTS and RUNS go both ways. Either one group per direction ("Hosts",
//   "Hosted by", "Runs", "Runs on"), or one group "Hosts / Hosted by" (and "Runs / Runs on") where
//   each row says "Hosts" or "Hosted by" ("Runs" or "Runs on").
// - Each related record is one row (a table row or a list item) showing the other end's number as
//   a link to that record's page, its name, its label and its status.
// - The page has one "Add link" button when the person may add a link (D200). It opens a dialog
//   holding:
//   - a choice named "Link type" (a select or a radio group), with one option per link the
//     ontology allows from this record, named like its group ("Controls that treat this risk";
//     on an asset "Hosts", "Hosted by", "Runs", "Runs on");
//   - a search box ("Search", a searchbox or a text box or combobox named Search or Find) that asks
//     the other end's list route with `q`;
//   - the records found, inside the dialog, each showing its number, to pick one;
//   - a button to add ("Add link", "Add", "Link" or "Save").
// - The API's refusals show in the dialog as a message (an alert).
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import {
  can,
  canLinkRecords,
  formatNumber,
  isAllowedLink,
  isRemovableLinkOrigin,
  isRole,
  isVisible,
  LABELS,
  RECORD_PATHS,
  riskRating,
  ROLE_TABLE,
  type Label,
  type RecordKind,
} from '@grc/shared';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { App } from '../../src/app/App';
import { choose, optionsOf, PEOPLE, resetApp as resetBase, type Person, type User } from '../records/helpers';

export { findDialog, mainText, optionsOf, waitForPath, type User } from '../records/helpers';
export const resetApp = resetBase;

export const ORG = { id: 'org-northwind', name: 'Northwind Health' };

export interface Me {
  id: string;
  name: string;
  role: string;
  clearance: Label;
}

export const ADMIN: Me = { id: 'user-marcus', name: 'Marcus Bell', role: 'admin', clearance: 'restricted' };
export const RISK_MANAGER: Me = {
  id: 'user-dana',
  name: 'Dana Whitfield',
  role: 'risk_manager',
  clearance: 'confidential',
};
export const ANALYST: Me = { id: 'user-omar', name: 'Omar Haddad', role: 'analyst', clearance: 'confidential' };
export const CONTROL_OWNER: Me = {
  id: 'user-priya',
  name: 'Priya Raman',
  role: 'control_owner',
  clearance: 'confidential',
};
export const VIEWER: Me = { id: 'user-vic', name: 'Vic Lowe', role: 'viewer', clearance: 'internal' };

/** Someone with this role and the highest clearance, so labels never hide a record. The Control
 * Owner is Priya, who owns C1 and C3. */
export function withRole(role: string): Me {
  const id = role === 'control_owner' ? 'user-priya' : `user-${role}`;
  return { id, name: `Test ${role}`, role, clearance: 'restricted' };
}

export const MEMBERS: Person[] = [...PEOPLE, { id: 'user-lena', name: 'Lena Ortiz', role: 'compliance_manager' }];

export const PAGE_PATHS: Record<RecordKind, string> = {
  risk: '/risks',
  control: '/controls',
  policy: '/policies',
  asset: '/assets',
  incident: '/incidents',
};

// ---- Records ------------------------------------------------------------------------------------

export interface StoredRecord {
  id: string;
  kind: RecordKind;
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
  [field: string]: unknown;
}

const KIND_DIGIT: Record<RecordKind, string> = { risk: '6', control: '7', policy: '8', asset: '9', incident: 'a' };

/** A lowercase UUID per kind and `n`, the same every time. */
export function idOf(kind: RecordKind, n: number): string {
  return `00000000-0000-4000-8000-${KIND_DIGIT[kind]}${String(n).padStart(11, '0')}`;
}

/** The on-screen number: `CTL0001001` for control 1. */
export function numberOf(kind: RecordKind, n: number): string {
  return formatNumber(kind, 1000 + n);
}

const OWN_FIELDS: Record<RecordKind, Record<string, unknown>> = {
  risk: { impact: 4, likelihood: 3, financialExposure: 50000 },
  control: { code: 'AC-2', framework: 'NIST 800-53', controlStatus: 'implemented', lastTestedDate: '2026-05-10' },
  policy: { policyVersion: '1.0', effectiveDate: '2026-01-05' },
  asset: { assetType: 'server', criticality: 'high', dataClassification: 'internal' },
  incident: { severity: 'high', incidentStatus: 'investigating', occurredAt: '2026-08-01T12:00:00.000Z' },
};

export function rec(kind: RecordKind, n: number, name: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: idOf(kind, n),
    kind,
    number: numberOf(kind, n),
    sourceIds: [],
    name,
    label: 'internal',
    status: 'active',
    owner: 'user-marcus',
    version: 1,
    createdAt: '2026-03-14T09:00:00.000Z',
    createdBy: 'user-marcus',
    updatedAt: '2026-09-18T10:15:00.000Z',
    updatedBy: 'user-marcus',
    origin: 'manual',
    ...OWN_FIELDS[kind],
    ...over,
  };
}

/** The fixed records. Names hold none of the group words ("hosts", "runs", "treat"…). */
export const R = {
  ransomware: rec('risk', 1, 'Ransomware on the claims servers', { owner: 'user-dana' }),
  vendor: rec('risk', 2, 'Vendor data breach', { owner: 'user-dana' }),
  insider: rec('risk', 3, 'Insider data theft', { label: 'restricted' }),
};
export const C = {
  mfa: rec('control', 1, 'Multi-factor authentication', { owner: 'user-priya', label: 'confidential' }),
  review: rec('control', 2, 'Quarterly access review', { status: 'retired' }),
  backups: rec('control', 3, 'Encrypted backups', { owner: 'user-priya' }),
  vault: rec('control', 4, 'Privileged access vault', { label: 'restricted' }),
};
export const P = {
  infosec: rec('policy', 1, 'Information Security Policy', { owner: 'user-lena' }),
  access: rec('policy', 2, 'Access Control Policy', { owner: 'user-lena' }),
};
export const A = {
  claims: rec('asset', 1, 'Claims processing server', { owner: 'user-omar' }),
  claimsApp: rec('asset', 2, 'Claims app'),
  billing: rec('asset', 3, 'Billing database', { label: 'confidential' }),
  core: rec('asset', 4, 'Core switch'),
  portal: rec('asset', 5, 'Patient portal', { label: 'restricted' }),
  cluster: rec('asset', 6, 'Hypervisor cluster'),
};
export const I = {
  phishing: rec('incident', 1, 'Phishing email led to credential theft'),
  fileShare: rec('incident', 2, 'Ransomware on the file share', { label: 'restricted' }),
};

export function allRecords(): StoredRecord[] {
  return [...Object.values(R), ...Object.values(C), ...Object.values(P), ...Object.values(A), ...Object.values(I)];
}

export interface StoredLink {
  type: string;
  fromId: string;
  toId: string;
  origin: 'manual' | 'import' | 'ai';
  createdAt: string;
  createdBy: string;
}

export function link(
  type: string,
  from: StoredRecord,
  to: StoredRecord,
  origin: StoredLink['origin'] = 'manual',
): StoredLink {
  return {
    type,
    fromId: from.id,
    toId: to.id,
    origin,
    createdAt: '2026-09-20T09:00:00.000Z',
    createdBy: 'user-marcus',
  };
}

/**
 * The fixed links, one or more in every group of every kind:
 * - risk R1: EXPOSED_TO in from A1 and A5 (restricted); MITIGATED_BY out to C1 (confidential), C2
 *   (retired) and C4 (restricted); EXPOSES in from I1 and I2 (restricted).
 * - control C1: MITIGATED_BY in from R1; GOVERNED_BY out to P1.
 * - asset A1: HOSTS out to A2, HOSTS in from A4; RUNS out to A3 (confidential), RUNS in from A6;
 *   EXPOSED_TO out to R1; IMPACTS in from I1.
 */
export function defaultLinks(): StoredLink[] {
  return [
    link('EXPOSED_TO', A.claims, R.ransomware),
    link('EXPOSED_TO', A.portal, R.ransomware),
    link('MITIGATED_BY', R.ransomware, C.mfa),
    link('MITIGATED_BY', R.ransomware, C.review),
    link('MITIGATED_BY', R.ransomware, C.vault),
    link('EXPOSES', I.phishing, R.ransomware),
    link('EXPOSES', I.fileShare, R.ransomware),
    link('GOVERNED_BY', C.mfa, P.infosec),
    link('HOSTS', A.claims, A.claimsApp),
    link('HOSTS', A.core, A.claims),
    link('RUNS', A.claims, A.billing, 'import'),
    link('RUNS', A.cluster, A.claims),
    link('IMPACTS', I.phishing, A.claims),
  ];
}

// ---- The fake API ------------------------------------------------------------------------------

export interface RecordedCall {
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
  return json(status, { error: { code, message, referenceId: referenceId ?? `ref-lnk-${refCounter}` } });
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

const KIND_OF_PATH: Record<string, RecordKind> = Object.fromEntries(
  Object.entries(RECORD_PATHS).map(([kind, path]) => [path, kind as RecordKind]),
);

const COMMON_PARAMS = ['page', 'pageSize', 'sort', 'status', 'owner', 'label', 'q'];
const OWN_PARAMS: Record<RecordKind, string[]> = {
  risk: ['band'],
  control: ['controlStatus', 'framework'],
  policy: [],
  asset: ['assetType', 'criticality'],
  incident: ['severity', 'incidentStatus'],
};

interface Override {
  method: string;
  path: RegExp;
  answer: ErrorAnswer;
  once: boolean;
}

/** A fake of the record routes of all five kinds and the S1-005 links routes. */
export class LinksApi {
  readonly calls: RecordedCall[] = [];
  readonly records: StoredRecord[];
  links: StoredLink[];
  readonly people: Person[];
  me: Me;
  private overrides: Override[] = [];

  constructor(opts: { me?: Me; records?: StoredRecord[]; links?: StoredLink[]; people?: Person[] } = {}) {
    this.me = opts.me ?? ADMIN;
    this.records = (opts.records ?? allRecords()).map((r) => ({ ...r }));
    this.links = (opts.links ?? defaultLinks()).map((l) => ({ ...l }));
    this.people = (opts.people ?? MEMBERS).map((p) => ({ ...p }));
  }

  /** Answers every matching request with this error (or only the next one). */
  fail(method: string, path: RegExp, answer: ErrorAnswer, once = false): void {
    this.overrides.push({ method, path, answer, once });
  }

  record(id: string): StoredRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  callsTo(path: string | RegExp, method = 'GET'): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method && (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname)),
    );
  }

  linksCalls(kind: RecordKind, id: string): RecordedCall[] {
    return this.callsTo(`/api/v1/${RECORD_PATHS[kind]}/${id}/links`);
  }

  /** The list-route searches for `kind` that carried `q`. */
  searches(kind: RecordKind): RecordedCall[] {
    return this.callsTo(`/api/v1/${RECORD_PATHS[kind]}`).filter((c) => c.url.searchParams.has('q'));
  }

  postLinkCalls(): RecordedCall[] {
    return this.callsTo('/api/v1/links', 'POST');
  }

  removeLinkCalls(): RecordedCall[] {
    return this.callsTo('/api/v1/links/remove', 'POST');
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const url = new URL(raw, window.location.href);
    const body = await readBody(input, init);
    this.calls.push({ raw, url, method, body });
    const i = this.overrides.findIndex((o) => o.method === method && o.path.test(url.pathname));
    if (i >= 0) {
      const o = this.overrides[i]!;
      if (o.once) this.overrides.splice(i, 1);
      return apiError(o.answer.status, o.answer.code, o.answer.message, o.answer.referenceId);
    }
    return this.handle(method, url, body);
  };

  private cell(kind: RecordKind): string {
    return isRole(this.me.role) ? ROLE_TABLE[kind][this.me.role] : 'none';
  }

  /** What the caller may see: the role's cell, ownership for `edit_own`, and the label. */
  visible(r: StoredRecord): boolean {
    const cell = this.cell(r.kind);
    if (cell === 'none') return false;
    if (cell === 'edit_own' && r.owner !== this.me.id) return false;
    return isVisible(this.me.clearance, r.label);
  }

  private out(r: StoredRecord): Record<string, unknown> {
    const { kind, ...rest } = r;
    if (kind === 'risk') return { ...rest, rating: riskRating(r.impact as number, r.likelihood as number) };
    return rest;
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
    if (method === 'POST' && path === '/api/v1/links') return this.createLink(body);
    if (method === 'POST' && path === '/api/v1/links/remove') return this.removeLink(body);

    const m = /^\/api\/v1\/(risks|controls|policies|assets|incidents)(?:\/([^/]+))?(\/links)?$/.exec(path);
    const kind = m ? KIND_OF_PATH[m[1]!] : undefined;
    if (m && kind && method === 'GET') {
      const id = m[2];
      if (id === undefined) return this.list(kind, url.searchParams);
      if (m[3] === undefined) return this.getOne(kind, id);
      return this.listLinks(kind, id);
    }
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

  private list(kind: RecordKind, params: URLSearchParams): Response {
    for (const [key, value] of params) {
      if (!COMMON_PARAMS.includes(key) && !OWN_PARAMS[kind].includes(key)) {
        return apiError(400, 'validation_failed', `${key}: unknown filter.`);
      }
      if (value.trim() === '') return apiError(400, 'validation_failed', `${key}: must not be empty.`);
    }
    const page = Number(params.get('page') ?? '1');
    const pageSize = Number(params.get('pageSize') ?? '25');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return apiError(400, 'validation_failed', 'page or pageSize is out of range.');
    }
    const status = params.get('status') ?? 'active';
    if (!['active', 'retired', 'all'].includes(status)) return apiError(400, 'validation_failed', 'status: bad value.');
    const label = params.get('label');
    if (label !== null && !(LABELS as readonly string[]).includes(label)) {
      return apiError(400, 'validation_failed', 'label: bad value.');
    }
    if (this.cell(kind) === 'none') return apiError(403, 'forbidden', 'You do not have permission to do this.');
    const q = params.get('q')?.trim().toLowerCase();
    const owner = params.get('owner');
    let rows = this.records.filter((r) => r.kind === kind && this.visible(r));
    if (status !== 'all') rows = rows.filter((r) => r.status === status);
    if (owner !== null) rows = rows.filter((r) => r.owner === owner);
    if (label !== null) rows = rows.filter((r) => r.label === label);
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.number.toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => a.number.localeCompare(b.number));
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => this.out(r));
    return json(200, { items, page, pageSize, total: rows.length });
  }

  private getOne(kind: RecordKind, id: string): Response {
    const r = this.record(id);
    if (!r || r.kind !== kind || !this.visible(r)) return apiError(404, 'not_found', 'The record was not found.');
    return json(200, this.out(r));
  }

  private listLinks(kind: RecordKind, id: string): Response {
    const r = this.record(id);
    if (!r || r.kind !== kind || !this.visible(r)) return apiError(404, 'not_found', 'The record was not found.');
    const items = [];
    for (const l of this.links) {
      const direction = l.fromId === id ? 'out' : l.toId === id ? 'in' : null;
      if (!direction) continue;
      const other = this.record(direction === 'out' ? l.toId : l.fromId);
      if (!other || !this.visible(other)) continue;
      items.push({
        type: l.type,
        direction,
        other: {
          id: other.id,
          kind: other.kind,
          number: other.number,
          name: other.name,
          label: other.label,
          status: other.status,
        },
        origin: l.origin,
        createdAt: l.createdAt,
        createdBy: l.createdBy,
      });
    }
    return json(200, { items });
  }

  private createLink(body: unknown): Response {
    const b = body as Record<string, unknown> | undefined;
    const keys = b && typeof b === 'object' ? Object.keys(b).sort() : [];
    if (
      keys.join(',') !== 'fromId,toId,type' ||
      typeof b!.type !== 'string' ||
      typeof b!.fromId !== 'string' ||
      typeof b!.toId !== 'string'
    ) {
      return apiError(400, 'validation_failed', 'The request body is not valid.');
    }
    const { type, fromId, toId } = b as { type: string; fromId: string; toId: string };
    const from = this.record(fromId);
    const to = this.record(toId);
    if (!from || !to || !this.visible(from) || !this.visible(to)) {
      return apiError(404, 'not_found', 'The record was not found.');
    }
    if (fromId === toId) return apiError(400, 'validation_failed', 'toId: a record cannot link to itself.');
    if (!isAllowedLink(type, from.kind, to.kind)) {
      return apiError(400, 'link_not_allowed', 'This link type is not allowed between these records.');
    }
    const caller = { userId: this.me.id, role: this.me.role, clearance: this.me.clearance };
    if (!canLinkRecords(caller, from, to)) return apiError(403, 'forbidden', 'You may not do this.');
    if (this.links.some((l) => l.type === type && l.fromId === fromId && l.toId === toId)) {
      return apiError(409, 'link_exists', 'This link already exists.');
    }
    const saved: StoredLink = {
      type,
      fromId,
      toId,
      origin: 'manual',
      createdAt: '2026-09-28T09:00:00.000Z',
      createdBy: this.me.id,
    };
    this.links.push(saved);
    return json(201, saved);
  }

  private removeLink(body: unknown): Response {
    const b = body as Record<string, unknown> | undefined;
    const keys = b && typeof b === 'object' ? Object.keys(b).sort() : [];
    if (
      keys.join(',') !== 'fromId,toId,type' ||
      typeof b!.type !== 'string' ||
      typeof b!.fromId !== 'string' ||
      typeof b!.toId !== 'string'
    ) {
      return apiError(400, 'validation_failed', 'The request body is not valid.');
    }
    const { type, fromId, toId } = b as { type: string; fromId: string; toId: string };
    const from = this.record(fromId);
    const to = this.record(toId);
    const index = this.links.findIndex((l) => l.type === type && l.fromId === fromId && l.toId === toId);
    if (!from || !to || !this.visible(from) || !this.visible(to) || index < 0) {
      return apiError(404, 'not_found', 'The record was not found.');
    }
    const caller = { userId: this.me.id, role: this.me.role, clearance: this.me.clearance };
    if (!canLinkRecords(caller, from, to)) return apiError(403, 'forbidden', 'You may not do this.');
    if (!isRemovableLinkOrigin(this.links[index]!.origin)) {
      return apiError(409, 'ai_link_review_only', AI_LINK_MESSAGE);
    }
    this.links.splice(index, 1);
    return json(200, { type, fromId, toId });
  }
}

// ---- Link removal (S1-011) -------------------------------------------------------------------

export const AI_LINK_MESSAGE = "This link was found by the AI. It can only be removed through the Analyst's review.";

// ---- Rendering ---------------------------------------------------------------------------------

/** Installs the fake API as `fetch`, opens the app at `path` with a live session. */
export function renderApp(path: string, api = new LinksApi()): { api: LinksApi; user: User } {
  vi.stubGlobal('fetch', api.fetch);
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

/** Opens a record's page and waits for its title and its links to have been asked for. */
export async function openRecord(record: StoredRecord, api: LinksApi): Promise<{ api: LinksApi; user: User }> {
  const opened = renderApp(`${PAGE_PATHS[record.kind]}/${record.id}`, api);
  await screen.findByRole('heading', { level: 1, name: new RegExp(record.number) });
  await waitFor(() => expect(api.linksCalls(record.kind, record.id).length).toBeGreaterThan(0));
  await flush();
  return opened;
}

/** Unmounts the page but keeps the fake API installed, like leaving and coming back. */
export function cleanupPage(): void {
  cleanup();
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A group of related records by its title. */
export function findGroup(title: RegExp): Promise<HTMLElement> {
  return waitFor(() => screen.getByRole('region', { name: title }));
}

export function queryGroup(title: RegExp): HTMLElement | null {
  return screen.queryByRole('region', { name: title });
}

const ROW = 'tr, li, [role="row"], [role="listitem"]';

/** The row in `scope` whose number link names `number`, or null. */
export function rowFor(scope: HTMLElement, number: string): HTMLElement | null {
  const link = within(scope).queryByRole('link', { name: new RegExp(number) });
  if (!link) return null;
  return link.closest<HTMLElement>(ROW);
}

/** The record numbers shown in `scope`. */
export function numbersIn(scope: HTMLElement): string[] {
  return [...(scope.textContent ?? '').matchAll(/(RSK|CTL|POL|AST|INC)\d{7}(?!\d)/g)].map((m) => m[0]);
}

/** The page's "Add link" button, or null. */
export function addLinkButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^add link$/i });
}

/** Opens the "Add link" dialog. */
export async function openAddLink(user: User): Promise<HTMLElement> {
  const button = await waitFor(() => screen.getByRole('button', { name: /^add link$/i }));
  await user.click(button);
  return waitFor(() => screen.getByRole('dialog'));
}

function linkTypeField(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByLabelText(/link type/i);
}

/** The link-type choices the dialog offers, as their shown text. */
export async function linkTypeOptions(user: User, dialog: HTMLElement): Promise<string[]> {
  const el = linkTypeField(dialog);
  if (el.getAttribute('role') === 'radiogroup') {
    return within(el)
      .getAllByRole('radio')
      .map((r) => (r.getAttribute('aria-label') ?? r.closest('label')?.textContent ?? labelText(r)).trim());
  }
  return optionsOf(user, el);
}

function labelText(el: HTMLElement): string {
  const id = el.getAttribute('id');
  const label = id ? document.querySelector(`label[for="${id}"]`) : null;
  return label?.textContent ?? el.textContent ?? '';
}

/** Picks the link type whose shown text matches `name`. */
export async function pickLinkType(user: User, dialog: HTMLElement, name: RegExp): Promise<void> {
  const el = linkTypeField(dialog);
  if (el.getAttribute('role') === 'radiogroup') {
    await user.click(within(el).getByRole('radio', { name }));
    return;
  }
  await choose(user, el, name);
}

function searchBox(dialog: HTMLElement): HTMLElement {
  return (
    within(dialog).queryByRole('searchbox') ??
    within(dialog).queryByRole('textbox', { name: /search|find/i }) ??
    within(dialog).getByRole('combobox', { name: /search|find/i })
  );
}

/** Types `text` into the dialog's search and waits for the other end's list route to be asked. */
export async function search(
  user: User,
  dialog: HTMLElement,
  api: LinksApi,
  kind: RecordKind,
  text: string,
): Promise<void> {
  const box = searchBox(dialog);
  await user.clear(box);
  await user.type(box, text);
  await waitFor(() => expect(api.searches(kind).some((c) => c.url.searchParams.get('q') === text)).toBe(true));
  await flush();
}

const PICKABLE = '[role="option"], button, [role="radio"], label, tr, li';

/** Picks the found record showing `number` in the dialog. */
export async function pickRecord(user: User, dialog: HTMLElement, number: string): Promise<void> {
  const target = await waitFor(() => {
    const found = [...dialog.querySelectorAll<HTMLElement>(PICKABLE)].filter((el) =>
      (el.textContent ?? '').includes(number),
    );
    expect(found.length, `a record ${number} to pick in the dialog`).toBeGreaterThan(0);
    return found[found.length - 1]!;
  });
  await user.click(target);
}

/** The dialog's add button. */
export function addButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /^(add link|add|link|save)$/i });
}

/** The fields of a group's rows, as the brief asks for: number link, name, label and status. */
export function expectRow(scope: HTMLElement, other: StoredRecord): HTMLElement {
  const row = rowFor(scope, other.number);
  expect(row, `a row for ${other.number}`).toBeTruthy();
  const link = within(row!).getByRole('link', { name: new RegExp(other.number) });
  expect(link.getAttribute('href')).toBe(`${PAGE_PATHS[other.kind]}/${other.id}`);
  const text = row!.textContent ?? '';
  expect(text).toContain(other.name);
  expect(text.toLowerCase()).toContain(other.label);
  expect(text.toLowerCase()).toContain(other.status);
  return row!;
}

/** Whether the D50 table lets this role edit `kind` (with `edit_own` on something they own). */
export function mayEditKind(role: string, kind: RecordKind): boolean {
  return can(role, kind, 'edit', { isOwner: true });
}
