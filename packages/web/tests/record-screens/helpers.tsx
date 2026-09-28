// Shared set-up for the S1-007 tests: the Controls, Policies, Assets and Incidents screens, built on
// S1-006's records kit.
//
// The API is mocked at the client boundary, like `tests/records/helpers.tsx`: `fetch` is replaced by
// a fake of the S1-004 record routes for the four kinds, so the generated typed client runs for real
// and every request is recorded. The fake follows the real API (S1-003, S1-004, S1 shared notes):
// - GET /api/v1/me answers the signed-in person; GET /api/v1/people the org's members, paged.
// - GET /api/v1/<kind> takes only the API's list parameters: page, pageSize, sort (number | name |
//   updatedAt, `-` for descending), status (active | retired | all), owner, label, q, plus the
//   kind's own filters: controls `controlStatus` and `framework` (plain text until S2), assets
//   `assetType` and `criticality`, incidents `severity` and `incidentStatus`; policies have none.
//   An unknown or empty parameter, or a value off the S1-001 lists, is refused with 400.
// - Access follows the D50 role table (`ROLE_TABLE` in @grc/shared) and the D51 labels:
//   - a kind the role can never view answers 403 on its list route (Incidents for a Control Owner
//     or a Viewer);
//   - a record the caller can't see (missing, a type the role can't view, a label above the
//     clearance, a control they don't own) answers 404 `not_found`, the same every time;
//   - `edit_own` (a Control Owner on Controls, D199, D206): the list holds only their own controls,
//     and they may edit every field of those, owner included. Once the owner changes, the control
//     is no longer theirs, so it drops out of their list and its page answers 404.
//   - Creating needs full `edit` on the kind (D199), so a Control Owner can't create a control.
// - POST and PATCH check the body with the shared S1-001 schemas, which refuse unknown fields.
//   PATCH compares `version` and answers 409 `stale_version` (D69). A label change follows
//   `canChangeLabel` and the clearance (D51, D198). An owner must be an org member.
// - POST /api/v1/<kind>/:id/retire takes `{ version }` and sets the status to retired.
// - Errors use the one D47 format with a reference ID.
//
// Contract with the app (S1-007 brief, S1-006's kit):
// - `/controls`, `/policies`, `/assets` and `/incidents` are the lists, each with `/new` (the create
//   form) and `/$id` (the record page), inside the signed-in shell. The left navigation ("Main")
//   links to each list.
// - Each list is a table with the kind's columns. Each row's number is a link to its page.
// - The kind's own filters are named "Control status", "Framework", "Asset type", "Criticality",
//   "Severity" and "Incident status", next to the kit's Search, Owner, Label and Status. Their
//   values go in the URL search params under the API's own names. The Framework filter may be a
//   text box or a choice; either way it sends the framework's text as stored (for example
//   `NIST 800-53`).
// - Form fields are found by their labels: Name, Owner, Label, plus Code, Framework, Control status
//   and Last tested (controls); Policy version and Effective date (policies); Asset type,
//   Criticality and Data classification (assets); Severity, Incident status and Occurred at
//   (incidents). A date may be a text box, a date input or a date-and-time input.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import {
  ASSET_TYPES,
  can,
  canChangeLabel,
  CONTROL_STATUSES,
  createSchemas,
  CRITICALITIES,
  formatNumber,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  isRole,
  isVisible,
  LABELS,
  ROLE_TABLE,
  updateSchemas,
  type Label,
  type RecordKind,
} from '@grc/shared';
import { App } from '../../src/app/App';
// The generic helpers (Radix shims, choice fields, dialogs) come from the S1-006 set-up.
import { choose, field, PEOPLE, type Person, type User } from '../records/helpers';

export {
  choose,
  columnHeader,
  dataRows,
  field,
  findDialog,
  mainText,
  optionsOf,
  PEOPLE,
  setField,
  waitForPath,
  type User,
} from '../records/helpers';

export type ScreenKind = Exclude<RecordKind, 'risk'>;

export const SCREEN_KINDS: readonly ScreenKind[] = ['control', 'policy', 'asset', 'incident'];

export const PATHS: Record<ScreenKind, string> = {
  control: '/controls',
  policy: '/policies',
  asset: '/assets',
  incident: '/incidents',
};

export const API_PATHS: Record<ScreenKind, string> = {
  control: '/api/v1/controls',
  policy: '/api/v1/policies',
  asset: '/api/v1/assets',
  incident: '/api/v1/incidents',
};

/** Singular, as the screens say it: "New control". */
export const NOUNS: Record<ScreenKind, string> = {
  control: 'control',
  policy: 'policy',
  asset: 'asset',
  incident: 'incident',
};

/** The navigation's names for the lists (M0's screens). */
export const NAV_NAMES: Record<ScreenKind, RegExp> = {
  control: /^controls$/i,
  policy: /^policies$/i,
  asset: /^assets$/i,
  incident: /^incidents$/i,
};

/** The M0 empty-state wording of each list (src/app/screens.ts). */
export const M0_EMPTY: Record<ScreenKind, string> = {
  control: 'No controls are recorded yet.',
  policy: 'No policies are recorded yet.',
  asset: 'No assets are recorded yet. Import an asset list from Data intake to fill this screen.',
  incident: 'No incidents are recorded yet.',
};

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
export const COMPLIANCE_MANAGER: Me = {
  id: 'user-lena',
  name: 'Lena Ortiz',
  role: 'compliance_manager',
  clearance: 'confidential',
};
export const CONTROL_OWNER: Me = {
  id: 'user-priya',
  name: 'Priya Raman',
  role: 'control_owner',
  clearance: 'confidential',
};
export const ANALYST: Me = { id: 'user-omar', name: 'Omar Haddad', role: 'analyst', clearance: 'confidential' };
export const VIEWER: Me = { id: 'user-vic', name: 'Vic Lowe', role: 'viewer', clearance: 'internal' };

/** Someone with this role and the highest clearance, so labels never hide a record. */
export function withRole(role: string, id = `user-${role}`): Me {
  return { id, name: `Test ${role}`, role, clearance: 'restricted' };
}

/** One editor per kind, from the D50 table (full `edit`), with confidential clearance. */
export const EDITORS: Record<ScreenKind, Me> = {
  control: COMPLIANCE_MANAGER,
  policy: COMPLIANCE_MANAGER,
  asset: { ...ADMIN, clearance: 'confidential' },
  incident: ANALYST,
};

/** Everyone the fake knows: the S1-006 people plus the Compliance Manager. */
export const MEMBERS: Person[] = [...PEOPLE, { id: 'user-lena', name: 'Lena Ortiz', role: 'compliance_manager' }];

// ---- Records ------------------------------------------------------------------------------------

export interface StoredRecord {
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
  [field: string]: unknown;
}

const KIND_DIGIT: Record<ScreenKind, string> = { control: '2', policy: '3', asset: '4', incident: '5' };

/** A lowercase UUID per kind and `n`, the same every time. */
export function recordId(kind: ScreenKind, n: number): string {
  return `00000000-0000-4000-8000-${KIND_DIGIT[kind]}${String(n).padStart(11, '0')}`;
}

/** The on-screen number: `CTL0001001` for control 1. */
export function recordNumber(kind: ScreenKind, n: number): string {
  return formatNumber(kind, 1000 + n);
}

function base(kind: ScreenKind, n: number, over: Partial<StoredRecord>): StoredRecord {
  return {
    id: recordId(kind, n),
    number: recordNumber(kind, n),
    sourceIds: [],
    name: `${NOUNS[kind]} ${n}`,
    label: 'internal',
    status: 'active',
    owner: 'user-marcus',
    version: 1,
    createdAt: '2026-03-14T09:00:00.000Z',
    createdBy: 'user-marcus',
    updatedAt: '2026-09-18T10:15:00.000Z',
    updatedBy: 'user-marcus',
    origin: 'manual',
    ...over,
  };
}

export function control(n: number, over: Partial<StoredRecord> = {}): StoredRecord {
  return base('control', n, {
    code: `AC-${n}`,
    framework: 'NIST 800-53',
    controlStatus: 'implemented',
    lastTestedDate: '2026-05-10',
    ...over,
  });
}

export function policy(n: number, over: Partial<StoredRecord> = {}): StoredRecord {
  return base('policy', n, { policyVersion: '1.0', effectiveDate: '2026-01-05', ...over });
}

export function asset(n: number, over: Partial<StoredRecord> = {}): StoredRecord {
  return base('asset', n, { assetType: 'server', criticality: 'medium', dataClassification: 'internal', ...over });
}

export function incident(n: number, over: Partial<StoredRecord> = {}): StoredRecord {
  return base('incident', n, {
    label: 'confidential',
    severity: 'medium',
    incidentStatus: 'new',
    occurredAt: '2026-08-01T12:00:00.000Z',
    ...over,
  });
}

/** Controls: Priya (the Control Owner) owns 1, 3 and the retired 5. */
export function controls(): StoredRecord[] {
  return [
    control(1, {
      name: 'Multi-factor authentication for remote access',
      code: 'AC-17',
      framework: 'NIST 800-53',
      controlStatus: 'implemented',
      lastTestedDate: '2026-06-30',
      owner: 'user-priya',
      version: 2,
    }),
    control(2, {
      name: 'Quarterly access review',
      code: 'A.5.18',
      framework: 'ISO 27001',
      controlStatus: 'planned',
      lastTestedDate: '2026-01-15',
      owner: 'user-marcus',
    }),
    control(3, {
      name: 'Encrypted backups',
      code: 'CP-9',
      framework: 'NIST 800-53',
      controlStatus: 'not_implemented',
      lastTestedDate: '2025-11-02',
      owner: 'user-priya',
      label: 'confidential',
    }),
    control(4, {
      name: 'Change approval board',
      code: 'CC8.1',
      framework: 'SOC 2',
      controlStatus: 'implemented',
      lastTestedDate: '2026-04-20',
      owner: 'user-dana',
    }),
    control(5, { name: 'Legacy firewall review', owner: 'user-priya', status: 'retired' }),
  ];
}

export function policies(): StoredRecord[] {
  return [
    policy(1, {
      name: 'Information Security Policy',
      policyVersion: '3.2',
      effectiveDate: '2026-02-01',
      owner: 'user-lena',
      version: 2,
    }),
    policy(2, { name: 'Acceptable Use Policy', policyVersion: '1.0', effectiveDate: '2025-07-15', owner: 'user-dana' }),
    policy(3, {
      name: 'Data Retention Policy',
      policyVersion: '2.1',
      effectiveDate: '2026-03-10',
      owner: 'user-lena',
      label: 'confidential',
    }),
    policy(4, { name: 'Old remote work policy', status: 'retired' }),
  ];
}

export function assets(): StoredRecord[] {
  return [
    asset(1, {
      name: 'Claims processing server',
      assetType: 'server',
      criticality: 'critical',
      dataClassification: 'confidential',
      label: 'confidential',
      owner: 'user-omar',
      version: 2,
    }),
    asset(2, {
      name: 'Patient portal',
      assetType: 'application',
      criticality: 'high',
      dataClassification: 'restricted',
      label: 'restricted',
    }),
    asset(3, { name: 'Billing database', assetType: 'database', criticality: 'high', owner: 'user-dana' }),
    asset(4, { name: 'Core switch', assetType: 'network_device', criticality: 'medium' }),
    asset(5, { name: 'Staff laptop fleet', assetType: 'endpoint', criticality: 'low', owner: 'user-omar' }),
    asset(6, { name: 'Decommissioned mail server', status: 'retired' }),
  ];
}

export function incidents(): StoredRecord[] {
  return [
    incident(1, {
      name: 'Phishing email led to credential theft',
      severity: 'high',
      incidentStatus: 'investigating',
      occurredAt: '2026-09-12T08:45:00.000Z',
      owner: 'user-omar',
      version: 2,
    }),
    incident(2, {
      name: 'Lost laptop',
      severity: 'low',
      incidentStatus: 'closed',
      occurredAt: '2026-05-03T16:20:00.000Z',
      label: 'internal',
    }),
    incident(3, {
      name: 'Ransomware on the file share',
      severity: 'critical',
      incidentStatus: 'contained',
      occurredAt: '2026-07-21T02:10:00.000Z',
      label: 'restricted',
    }),
    incident(4, {
      name: 'Misdirected email',
      severity: 'medium',
      incidentStatus: 'resolved',
      occurredAt: '2026-06-02T11:00:00.000Z',
    }),
    incident(5, { name: 'Old phishing test', status: 'retired' }),
  ];
}

export function defaultRecords(): Record<ScreenKind, StoredRecord[]> {
  return { control: controls(), policy: policies(), asset: assets(), incident: incidents() };
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
  return json(status, { error: { code, message, referenceId: referenceId ?? `ref-scr-${refCounter}` } });
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

const COMMON_PARAMS = ['page', 'pageSize', 'sort', 'status', 'owner', 'label', 'q'];

/** Each kind's own list filters and their allowed values (`null`: any non-empty text). */
export const OWN_FILTERS: Record<ScreenKind, Record<string, readonly string[] | null>> = {
  control: { controlStatus: CONTROL_STATUSES, framework: null },
  policy: {},
  asset: { assetType: ASSET_TYPES, criticality: CRITICALITIES },
  incident: { severity: INCIDENT_SEVERITIES, incidentStatus: INCIDENT_STATUSES },
};

const SORTS = ['number', 'name', 'updatedAt'];

const KIND_OF_PATH: Record<string, ScreenKind> = {
  controls: 'control',
  policies: 'policy',
  assets: 'asset',
  incidents: 'incident',
};

interface Override {
  method: string;
  path: RegExp;
  answer: ErrorAnswer;
  once: boolean;
}

/** A fake of the S1-004 record routes for the four kinds, the people list and /me. */
export class ScreensApi {
  readonly calls: RecordedCall[] = [];
  readonly records: Record<ScreenKind, StoredRecord[]>;
  readonly people: Person[];
  me: Me;
  private overrides: Override[] = [];
  private nextN = 900;

  constructor(opts: { me?: Me; records?: Partial<Record<ScreenKind, StoredRecord[]>>; people?: Person[] } = {}) {
    this.me = opts.me ?? ADMIN;
    const all = { ...defaultRecords(), ...(opts.records ?? {}) };
    this.records = {
      control: all.control.map((r) => ({ ...r })),
      policy: all.policy.map((r) => ({ ...r })),
      asset: all.asset.map((r) => ({ ...r })),
      incident: all.incident.map((r) => ({ ...r })),
    };
    this.people = (opts.people ?? MEMBERS).map((p) => ({ ...p }));
  }

  /** Answers every matching request with this error (or only the next one). */
  fail(method: string, path: RegExp, answer: ErrorAnswer, once = false): void {
    this.overrides.push({ method, path, answer, once });
  }

  record(kind: ScreenKind, id: string): StoredRecord | undefined {
    return this.records[kind].find((r) => r.id === id);
  }

  /** Someone else saves the record: its version goes up and its name changes. */
  changeBehindTheScenes(kind: ScreenKind, id: string, name: string): void {
    const r = this.record(kind, id)!;
    r.name = name;
    r.version += 1;
    r.updatedAt = '2026-09-28T08:00:00.000Z';
  }

  callsTo(path: string | RegExp, method = 'GET'): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method && (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname)),
    );
  }

  listCalls(kind: ScreenKind): RecordedCall[] {
    return this.callsTo(API_PATHS[kind], 'GET');
  }

  lastListCall(kind: ScreenKind): RecordedCall {
    const calls = this.listCalls(kind);
    expect(calls.length, `the ${kind} list asked the API`).toBeGreaterThan(0);
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
    const i = this.overrides.findIndex((o) => o.method === method && o.path.test(url.pathname));
    if (i >= 0) {
      const o = this.overrides[i]!;
      if (o.once) this.overrides.splice(i, 1);
      return apiError(o.answer.status, o.answer.code, o.answer.message, o.answer.referenceId);
    }
    return this.handle(method, url, body);
  };

  private cell(kind: ScreenKind): string {
    return isRole(this.me.role) ? ROLE_TABLE[kind][this.me.role] : 'none';
  }

  /** What the caller may see: the role's cell, ownership for `edit_own`, and the label. */
  private visible(kind: ScreenKind, r: StoredRecord): boolean {
    const cell = this.cell(kind);
    if (cell === 'none') return false;
    if (cell === 'edit_own' && r.owner !== this.me.id) return false;
    return isVisible(this.me.clearance, r.label);
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

    const m = /^\/api\/v1\/(controls|policies|assets|incidents)(?:\/([^/]+))?(\/retire)?$/.exec(path);
    const kind = m ? KIND_OF_PATH[m[1]!] : undefined;
    if (m && kind) {
      const id = m[2];
      if (id === undefined) {
        if (method === 'GET') return this.list(kind, url.searchParams);
        if (method === 'POST') return this.create(kind, body);
      } else if (m[3] === undefined) {
        if (method === 'GET') return this.getOne(kind, id);
        if (method === 'PATCH') return this.update(kind, id, body);
      } else if (method === 'POST') {
        return this.retire(kind, id, body);
      }
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

  private list(kind: ScreenKind, params: URLSearchParams): Response {
    const own = OWN_FILTERS[kind];
    for (const [key, value] of params) {
      if (!COMMON_PARAMS.includes(key) && !(key in own)) {
        return apiError(400, 'validation_failed', `${key}: unknown filter.`);
      }
      if (value.trim() === '') return apiError(400, 'validation_failed', `${key}: must not be empty.`);
      const allowed = own[key];
      if (allowed && !allowed.includes(value)) return apiError(400, 'validation_failed', `${key}: bad value.`);
    }
    const page = Number(params.get('page') ?? '1');
    const pageSize = Number(params.get('pageSize') ?? '25');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return apiError(400, 'validation_failed', 'page or pageSize is out of range.');
    }
    const sort = params.get('sort') ?? 'number';
    const sortField = sort.replace(/^-/, '');
    if (!SORTS.includes(sortField)) return apiError(400, 'validation_failed', 'sort: unknown field.');
    const status = params.get('status') ?? 'active';
    if (!['active', 'retired', 'all'].includes(status)) return apiError(400, 'validation_failed', 'status: bad value.');
    const label = params.get('label');
    if (label !== null && !(LABELS as readonly string[]).includes(label)) {
      return apiError(400, 'validation_failed', 'label: bad value.');
    }
    if (this.cell(kind) === 'none') {
      return apiError(403, 'forbidden', 'You do not have permission to do this.');
    }
    const owner = params.get('owner');
    const q = params.get('q')?.trim().toLowerCase();

    let rows = this.records[kind].filter((r) => this.visible(kind, r));
    if (status !== 'all') rows = rows.filter((r) => r.status === status);
    if (owner !== null) rows = rows.filter((r) => r.owner === owner);
    if (label !== null) rows = rows.filter((r) => r.label === label);
    for (const key of Object.keys(own)) {
      const value = params.get(key);
      if (value !== null) rows = rows.filter((r) => r[key] === value);
    }
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.number.toLowerCase().includes(q));

    const dir = sort.startsWith('-') ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const ka = String(a[sortField]);
      const kb = String(b[sortField]);
      if (ka === kb) return a.number.localeCompare(b.number);
      return (ka < kb ? -1 : 1) * dir;
    });
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return json(200, { items, page, pageSize, total: rows.length });
  }

  private getOne(kind: ScreenKind, id: string): Response {
    const r = this.record(kind, id);
    if (!r || !this.visible(kind, r)) return apiError(404, 'not_found', 'The record was not found.');
    return json(200, r);
  }

  private create(kind: ScreenKind, body: unknown): Response {
    const parsed = createSchemas[kind].safeParse(body);
    if (!parsed.success) return apiError(400, 'validation_failed', 'The request body is not valid.');
    if (!can(this.me.role, kind, 'edit')) return apiError(403, 'forbidden', 'You do not have permission to do this.');
    const data = parsed.data as Record<string, unknown>;
    const label = (data.label as Label | undefined) ?? 'internal';
    if (!isVisible(this.me.clearance, label)) return apiError(403, 'forbidden', 'You may not set this label.');
    const owner = (data.owner as string | undefined) ?? this.me.id;
    if (!this.people.some((p) => p.id === owner)) {
      return apiError(400, 'validation_failed', 'owner: must be a member of this organization.');
    }
    this.nextN += 1;
    const r = base(kind, this.nextN, {
      ...data,
      owner,
      label,
      createdAt: '2026-09-28T09:00:00.000Z',
      updatedAt: '2026-09-28T09:00:00.000Z',
      createdBy: this.me.id,
      updatedBy: this.me.id,
    });
    this.records[kind].push(r);
    return json(201, r);
  }

  private update(kind: ScreenKind, id: string, body: unknown): Response {
    const parsed = updateSchemas[kind].safeParse(body);
    if (!parsed.success) return apiError(400, 'validation_failed', 'The request body is not valid.');
    const r = this.record(kind, id);
    if (!r || !this.visible(kind, r)) return apiError(404, 'not_found', 'The record was not found.');
    if (!can(this.me.role, kind, 'edit', { isOwner: r.owner === this.me.id })) {
      return apiError(403, 'forbidden', 'You may not do this.');
    }
    const changes: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };
    if (changes.version !== r.version) {
      return apiError(409, 'stale_version', 'This record changed since you opened it. Reload it and try again.');
    }
    delete changes.version;
    const to = changes.label as Label | undefined;
    if (to !== undefined && to !== r.label) {
      if (!isVisible(this.me.clearance, to) || !canChangeLabel(this.me.role, r.label, to)) {
        return apiError(403, 'forbidden', 'You may not set this label.');
      }
    }
    const owner = changes.owner as string | undefined;
    if (owner !== undefined && !this.people.some((p) => p.id === owner)) {
      return apiError(400, 'validation_failed', 'owner: must be a member of this organization.');
    }
    Object.assign(r, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
    r.version += 1;
    r.updatedAt = '2026-09-28T09:30:00.000Z';
    r.updatedBy = this.me.id;
    return json(200, r);
  }

  private retire(kind: ScreenKind, id: string, body: unknown): Response {
    const version = (body as { version?: unknown } | undefined)?.version;
    const extra = body && typeof body === 'object' ? Object.keys(body).filter((k) => k !== 'version') : [];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || extra.length > 0) {
      return apiError(400, 'validation_failed', 'version: must be a whole number from 1.');
    }
    const r = this.record(kind, id);
    if (!r || !this.visible(kind, r)) return apiError(404, 'not_found', 'The record was not found.');
    if (!can(this.me.role, kind, 'edit', { isOwner: r.owner === this.me.id })) {
      return apiError(403, 'forbidden', 'You may not do this.');
    }
    if (version !== r.version) {
      return apiError(409, 'stale_version', 'This record changed since you opened it. Reload it and try again.');
    }
    r.status = 'retired';
    r.version += 1;
    return json(200, r);
  }
}

// ---- Rendering ---------------------------------------------------------------------------------

/** Installs the fake API as `fetch`, opens the app at `path` with a live session. */
export function renderApp(path: string, api = new ScreensApi()): { api: ScreensApi; user: User } {
  vi.stubGlobal('fetch', api.fetch);
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

/** Unmounts the app but keeps the address, like a page reload. */
export function reload(api: ScreensApi): { api: ScreensApi; user: User } {
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

const NUMBER = /\b[A-Z]{3}\d{7}\b/;

/** The list's table, once it shows at least one data row. */
export async function findList(): Promise<HTMLElement> {
  return waitFor(() => {
    const table = screen.getByRole('table');
    expect(rowsOf(table).length).toBeGreaterThan(0);
    return table;
  });
}

function rowsOf(table: HTMLElement): HTMLElement[] {
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0);
}

/** The number shown in each data row, in order. */
export function rowNumbers(table: HTMLElement): string[] {
  return rowsOf(table).map((row) => NUMBER.exec(row.textContent ?? '')?.[0] ?? '');
}

/** The text of the cell under the column whose header matches `header`, in the row for `number`. */
export function cellText(table: HTMLElement, number: string, header: RegExp): string {
  const headers = within(table).getAllByRole('columnheader');
  const index = headers.findIndex((h) => header.test((h.textContent ?? '').trim()));
  expect(index, `a column matching ${header}`).toBeGreaterThanOrEqual(0);
  const row = rowsOf(table).find((r) => (r.textContent ?? '').includes(number));
  expect(row, `a row for ${number}`).toBeTruthy();
  const cells = within(row!).getAllByRole('cell');
  return (cells[index]?.textContent ?? '').trim();
}

/** The record page's title, the record's number (S1-006's page). */
export async function findTitle(number: string): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name: new RegExp(number) });
}

/** The Edit button or link on a record page, or null. */
export function editControl(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
}

/** Opens the record page's edit form. */
export async function openEditForm(user: User, number: string): Promise<void> {
  await findTitle(number);
  const edit = editControl();
  expect(edit, 'an Edit button or link').toBeTruthy();
  await user.click(edit!);
  await waitFor(() => field(/^name/i));
}

/** The list's "New <noun>" button or link, or null. */
export function newButton(kind: ScreenKind): HTMLElement | null {
  const name = new RegExp(`new ${NOUNS[kind]}`, 'i');
  return screen.queryByRole('link', { name }) ?? screen.queryByRole('button', { name });
}

/** The Save or Create button of a form. */
export function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(save|create)/i });
}

/** A list filter by its accessible name (a choice, or a text box for Framework). */
export function filter(name: RegExp): HTMLElement {
  return screen.getByLabelText(name);
}

/**
 * Sets a date field. A date input takes `YYYY-MM-DD`; a date-and-time input takes
 * `YYYY-MM-DDThh:mm`; a text box gets the full value typed in.
 */
export async function setDate(user: User, label: RegExp, value: { date: string; time?: string }): Promise<void> {
  const el = field(label) as HTMLInputElement;
  if (el.type === 'date') {
    fireEvent.change(el, { target: { value: value.date } });
  } else if (el.type === 'datetime-local') {
    fireEvent.change(el, { target: { value: `${value.date}T${value.time ?? '00:00'}` } });
  } else {
    await user.clear(el);
    await user.type(el, value.time ? `${value.date}T${value.time}:00Z` : value.date);
  }
}

/** The body's text with every <select> and <option> left out (owner pickers list every member). */
export function textOutsideChoices(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('select, option, [role="listbox"], [role="option"]').forEach((el) => el.remove());
  return copy.textContent ?? '';
}

/** Picks a value in a filter: a choice by its shown text, or a text box by typing. */
export async function setFilter(user: User, name: RegExp, shown: RegExp, typed: string): Promise<void> {
  const el = filter(name);
  if (el.tagName === 'INPUT') {
    await user.clear(el);
    await user.type(el, typed);
    return;
  }
  await choose(user, el, shown);
}

/** `not_implemented` as a value-list key, from its shown text `Not implemented`. */
export function asValue(shown: string): string {
  return shown.trim().toLowerCase().replace(/\s+/g, '_');
}
