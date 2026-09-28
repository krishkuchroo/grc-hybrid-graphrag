// S1-003 criterion 2 (permissions) at the service level, D50, D54, D59, D199: every role × kind ×
// action from ROLE_TABLE, for people and for API keys. The cases are generated from ROLE_TABLE,
// ROLES and RECORD_KINDS, so they can't drift from the table.
// - create, update and retire need the `edit` cell; `edit_own` (a Control Owner on controls) may
//   update and retire only controls they own, and never create (403).
// - A record the caller can't see (a type they can't view, or a control they don't own) is 404.
//   A visible record they may not edit is 403. `list` on a type the role can never view is 403.
// - A refused update or retire changes nothing.
// Every record here is labelled `public` and callers have clearance `restricted` (people) or
// `internal` (API keys), so labels never decide these cases; visibility.db.test.ts covers labels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORD_KINDS, ROLE_TABLE } from '@grc/shared';
import {
  LONG,
  ROLES,
  T,
  caller,
  fieldChange,
  keyCaller,
  newTestOrg,
  outcome,
  service,
  setUpRecords,
  storedNode,
  tearDownRecords,
  validInput,
  type Caller,
  type RecEnv,
  type RecordKind,
  type RecordOut,
  type Role,
  type TestOrg,
} from './helpers.js';

type Expect = 'ok' | 403 | 404;
type Action = 'create' | 'get' | 'list' | 'update' | 'retire';

/** The D50 answer for one role, kind and action (with `owned` for the "own" cells). */
function expected(role: Role, kind: RecordKind, action: Action, owned = false): Expect {
  const cell = ROLE_TABLE[kind][role];
  switch (action) {
    case 'create':
      return cell === 'edit' ? 'ok' : 403;
    case 'list':
      return cell === 'none' ? 403 : 'ok';
    case 'get':
      if (cell === 'none') return 404;
      if (cell === 'edit_own') return owned ? 'ok' : 404;
      return 'ok';
    case 'update':
    case 'retire':
      if (cell === 'none') return 404;
      if (cell === 'edit_own') return owned ? 'ok' : 404;
      if (cell === 'view') return 403;
      return 'ok';
  }
}

const CASES = ROLES.flatMap((role) => RECORD_KINDS.map((kind) => [role, kind, ROLE_TABLE[kind][role]] as const));

let env: RecEnv;
let org: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Permissions');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

/** A fresh public record, made by the Admin and owned by the Admin. */
async function adminRecord(kind: RecordKind, owner?: string): Promise<RecordOut> {
  const svc = await service(env);
  return svc.create(caller(org, 'admin'), kind, validInput(kind, { label: 'public', ...(owner ? { owner } : {}) }));
}

/** The body a caller would send for a create: API keys must name an owner. */
function createBody(kind: RecordKind, who: Caller): Record<string, unknown> {
  return validInput(kind, { label: 'public', ...(who.apiKeyId ? { owner: org.adminId } : {}) });
}

async function expectUnchanged(kind: RecordKind, before: RecordOut): Promise<void> {
  const node = await storedNode(env, org.id, kind, before.id);
  expect(node?.['version']).toBe(before.version);
  expect(node?.['status']).toBe(before.status);
}

async function checkCreate(who: Caller, role: Role, kind: RecordKind): Promise<void> {
  const svc = await service(env);
  expect(await outcome(svc.create(who, kind, createBody(kind, who)))).toBe(expected(role, kind, 'create'));
}

async function checkGet(who: Caller, role: Role, kind: RecordKind): Promise<void> {
  const svc = await service(env);
  const rec = await adminRecord(kind);
  expect(await outcome(svc.get(who, kind, rec.id))).toBe(expected(role, kind, 'get'));
}

async function checkList(who: Caller, role: Role, kind: RecordKind): Promise<void> {
  const svc = await service(env);
  const rec = await adminRecord(kind);
  const want = expected(role, kind, 'list');
  let page: { items: RecordOut[] } | undefined;
  const got = await outcome(
    svc.list(who, kind, { pageSize: 100, q: rec.number }).then((p) => {
      page = p;
    }),
  );
  expect(got).toBe(want);
  if (want === 'ok') {
    const shown = (page?.items ?? []).some((r) => r.id === rec.id);
    expect(shown, 'the Admin-owned record in the list').toBe(expected(role, kind, 'get') === 'ok');
  }
}

async function checkUpdate(who: Caller, role: Role, kind: RecordKind): Promise<void> {
  const svc = await service(env);
  const rec = await adminRecord(kind);
  const want = expected(role, kind, 'update');
  expect(await outcome(svc.update(who, kind, rec.id, { ...fieldChange(kind), version: rec.version }))).toBe(want);
  if (want === 'ok') expect((await storedNode(env, org.id, kind, rec.id))?.['version']).toBe(rec.version + 1);
  else await expectUnchanged(kind, rec);
}

async function checkRetire(who: Caller, role: Role, kind: RecordKind): Promise<void> {
  const svc = await service(env);
  const rec = await adminRecord(kind);
  const want = expected(role, kind, 'retire');
  expect(await outcome(svc.retire(who, kind, rec.id, rec.version))).toBe(want);
  if (want === 'ok') expect((await storedNode(env, org.id, kind, rec.id))?.['status']).toBe('retired');
  else await expectUnchanged(kind, rec);
}

describe('people: every role × kind × action matches ROLE_TABLE (D50, D59)', { timeout: T }, () => {
  it.each(CASES)('%s on %s (cell %s): create', async (role, kind) => {
    await checkCreate(caller(org, role), role, kind);
  });

  it.each(CASES)('%s on %s (cell %s): get', async (role, kind) => {
    await checkGet(caller(org, role), role, kind);
  });

  it.each(CASES)('%s on %s (cell %s): list', async (role, kind) => {
    await checkList(caller(org, role), role, kind);
  });

  it.each(CASES)('%s on %s (cell %s): update', async (role, kind) => {
    await checkUpdate(caller(org, role), role, kind);
  });

  it.each(CASES)('%s on %s (cell %s): retire', async (role, kind) => {
    await checkRetire(caller(org, role), role, kind);
  });
});

describe('API keys: the same rules with their one role (D54)', { timeout: T }, () => {
  it.each(CASES)('%s key on %s (cell %s): create', async (role, kind) => {
    await checkCreate(keyCaller(org, role), role, kind);
  });

  it.each(CASES)('%s key on %s (cell %s): get', async (role, kind) => {
    await checkGet(keyCaller(org, role), role, kind);
  });

  it.each(CASES)('%s key on %s (cell %s): update', async (role, kind) => {
    await checkUpdate(keyCaller(org, role), role, kind);
  });

  it.each(CASES)('%s key on %s (cell %s): retire', async (role, kind) => {
    await checkRetire(keyCaller(org, role), role, kind);
  });
});

describe('the "own" cell (D50, D199)', { timeout: T }, () => {
  const ownCells = CASES.filter(([, , cell]) => cell === 'edit_own');

  it.each(ownCells)('%s on an owned %s: get, update and retire are allowed', async (role, kind) => {
    const svc = await service(env);
    const who = caller(org, role);
    const rec = await adminRecord(kind, who.userId);
    expect(await outcome(svc.get(who, kind, rec.id))).toBe(expected(role, kind, 'get', true));
    const updated = await svc.update(who, kind, rec.id, { ...fieldChange(kind), version: rec.version });
    expect(updated.version).toBe(rec.version + 1);
    const retired = await svc.retire(who, kind, rec.id, updated.version);
    expect(retired.status).toBe('retired');
  });

  it.each(ownCells)('%s creating a %s is 403 even when naming themselves as owner (D199)', async (role, kind) => {
    // The table cell these tests rely on is still the only "own" cell for the five kinds.
    expect(ownCells.map(([r, k]) => `${r}/${k}`)).toEqual(['control_owner/control']);
    const svc = await service(env);
    const who = caller(org, role);
    expect(await outcome(svc.create(who, kind, validInput(kind, { owner: who.userId })))).toBe(403);
  });
});
