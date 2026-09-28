// S1-003 criteria 5 (update) and 6 (labels): D69 (version check), D51 (editors may raise a label,
// only an Admin may lower one), D198 (no label above the caller's own clearance, for every role,
// Admin included, and for API keys).
// - A `version` that isn't the stored one is 409 `stale_version`, and nothing changes.
// - Otherwise only the given fields change, `version` goes up by 1, `updatedAt` and `updatedBy`
//   are set. Two updates at once with the same version: exactly one wins, the other is 409.
// - A refused label is 403 `forbidden`, and nothing changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABELS, RECORD_KINDS, ROLES, ROLE_TABLE, canChangeLabel, isVisible, riskRating } from '@grc/shared';
import {
  LONG,
  T,
  caller,
  keyCaller,
  newTestOrg,
  nodeCount,
  outcome,
  refusedWith,
  service,
  setUpRecords,
  storedNode,
  tearDownRecords,
  uniqueName,
  validInput,
  type RecEnv,
  type RecordOut,
  type Role,
  type TestOrg,
} from './helpers.js';

const STALE_MESSAGE = 'This record changed since you opened it. Reload it and try again.';

let env: RecEnv;
let org: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Updates');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

async function adminRisk(extra: Record<string, unknown> = {}): Promise<RecordOut> {
  const svc = await service(env);
  return svc.create(caller(org, 'admin'), 'risk', validInput('risk', extra));
}

describe('the version check (D69)', { timeout: T }, () => {
  it.each([2, 7])('version %i on a version-1 record is 409 stale_version, and nothing changes', async (version) => {
    const svc = await service(env);
    const rec = await adminRisk();
    const r = await refusedWith(
      svc.update(caller(org, 'admin'), 'risk', rec.id, { name: uniqueName('stale'), version }),
      409,
      'stale_version',
    );
    expect(r.message).toBe(STALE_MESSAGE);
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['name']).toBe(rec.name);
    expect(node?.['version']).toBe(1);
  });

  it('a body without version is 400 validation_failed, and nothing changes', async () => {
    const svc = await service(env);
    const rec = await adminRisk();
    await refusedWith(
      svc.update(caller(org, 'admin'), 'risk', rec.id, { name: uniqueName('x') }),
      400,
      'validation_failed',
    );
    expect((await storedNode(env, org.id, 'risk', rec.id))?.['name']).toBe(rec.name);
  });

  it.each([
    ['an id', { id: '00000000-0000-4000-8000-000000000001' }],
    ['a number', { number: 'RSK0009999' }],
    ['a status', { status: 'retired' }],
    ['an unknown field', { colour: 'red' }],
    ['a likelihood off the scale', { likelihood: 0 }],
  ])('a body with %s is 400 validation_failed', async (_what, extra) => {
    const svc = await service(env);
    const rec = await adminRisk();
    await refusedWith(
      svc.update(caller(org, 'admin'), 'risk', rec.id, { ...extra, version: 1 }),
      400,
      'validation_failed',
    );
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['version']).toBe(1);
    expect(node?.['status']).toBe('active');
  });

  it("an id that doesn't exist is 404 not_found", async () => {
    const svc = await service(env);
    await refusedWith(
      svc.update(caller(org, 'admin'), 'risk', '00000000-0000-4000-8000-0000000000aa', { name: 'x', version: 1 }),
      404,
      'not_found',
    );
  });

  it('two updates at once with the same version: exactly one wins, the other is 409', async () => {
    const svc = await service(env);
    const rec = await adminRisk();
    const who = caller(org, 'admin');
    const results = await Promise.allSettled([
      svc.update(who, 'risk', rec.id, { name: uniqueName('first'), version: 1 }),
      svc.update(who, 'risk', rec.id, { name: uniqueName('second'), version: 1 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    await refusedWith(Promise.reject((lost[0] as PromiseRejectedResult).reason), 409, 'stale_version');
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['version']).toBe(2);
    expect(node?.['name']).toBe((won[0] as PromiseFulfilledResult<RecordOut>).value.name);
  });
});

describe('a successful update', { timeout: T }, () => {
  it('changes only the given fields and raises the version by 1', async () => {
    const svc = await service(env);
    const rec = await adminRisk({ impact: 2, likelihood: 3, financialExposure: 1000 });
    const out = await svc.update(caller(org, 'admin'), 'risk', rec.id, { impact: 5, version: 1 });
    expect(out).toMatchObject({ impact: 5, likelihood: 3, financialExposure: 1000, name: rec.name, version: 2 });
    expect(out.number).toBe(rec.number);
    expect(out.owner).toBe(rec.owner);
    expect(out.label).toBe(rec.label);
    expect(out.createdAt).toBe(rec.createdAt);
    expect(out.createdBy).toBe(rec.createdBy);
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node).toMatchObject({ impact: 5, likelihood: 3, financialExposure: 1000, name: rec.name, version: 2 });
  });

  it('sets updatedAt and updatedBy', async () => {
    const svc = await service(env);
    const rec = await adminRisk();
    const out = await svc.update(caller(org, 'risk_manager'), 'risk', rec.id, {
      name: uniqueName('renamed'),
      version: 1,
    });
    expect(out.updatedBy).toBe(org.users.byRole.risk_manager);
    expect(Date.parse(out.updatedAt)).toBeGreaterThanOrEqual(Date.parse(rec.updatedAt));
    expect(out.updatedAt).not.toBe(rec.updatedAt);
  });

  it('recomputes the risk rating (D197)', async () => {
    const svc = await service(env);
    const rec = await adminRisk({ impact: 1, likelihood: 2 });
    const out = await svc.update(caller(org, 'admin'), 'risk', rec.id, { likelihood: 5, version: 1 });
    expect(out.rating).toEqual(riskRating(1, 5));
  });

  it('an update after an update needs the new version', async () => {
    const svc = await service(env);
    const rec = await adminRisk();
    const who = caller(org, 'admin');
    const v2 = await svc.update(who, 'risk', rec.id, { impact: 1, version: 1 });
    const v3 = await svc.update(who, 'risk', rec.id, { impact: 2, version: v2.version });
    expect(v3.version).toBe(3);
    await refusedWith(svc.update(who, 'risk', rec.id, { impact: 3, version: 2 }), 409, 'stale_version');
  });

  it.each(RECORD_KINDS)('works for a %s', async (kind) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), kind, validInput(kind));
    const name = uniqueName(`${kind} renamed`);
    const out = await svc.update(caller(org, 'admin'), kind, rec.id, { name, version: 1 });
    expect(out).toMatchObject({ id: rec.id, name, version: 2 });
  });
});

// ---------- labels ----------

/** The roles with the `edit` cell on some kind, each with one kind it may create and edit. */
const EDITORS = ROLES.flatMap((role) => {
  const kind = RECORD_KINDS.find((k) => ROLE_TABLE[k][role] === 'edit');
  return kind ? [[role, kind] as const] : [];
});

const CLEARANCE_LABEL = LABELS.flatMap((clearance) => LABELS.map((label) => [clearance, label] as const));
const EDITOR_CASES = EDITORS.flatMap(([role, kind]) =>
  CLEARANCE_LABEL.map(([clearance, label]) => [role, kind, clearance, label] as const),
);

describe("no label above the caller's clearance on create (D198)", { timeout: T }, () => {
  it.each(EDITOR_CASES)('%s creating a %s, clearance %s, label %s', async (role, kind, clearance, label) => {
    const svc = await service(env);
    const input = validInput(kind, { label });
    const got = await outcome(svc.create(caller(org, role as Role, clearance), kind, input));
    const allowed = isVisible(clearance, label);
    expect(got).toBe(allowed ? 'ok' : 403);
    if (!allowed) expect(await nodeCount(env, org.id, kind, { name: input['name'] })).toBe(0);
  });

  it.each(LABELS)('an API key (clearance internal) creating a risk labelled %s', async (label) => {
    const svc = await service(env);
    const input = validInput('risk', { label, owner: org.adminId });
    const got = await outcome(svc.create(keyCaller(org, 'risk_manager'), 'risk', input));
    expect(got).toBe(isVisible('internal', label) ? 'ok' : 403);
  });

  it('the refusal is 403 forbidden', async () => {
    const svc = await service(env);
    await refusedWith(
      svc.create(caller(org, 'admin', 'internal'), 'risk', validInput('risk', { label: 'confidential' })),
      403,
      'forbidden',
    );
  });
});

describe("no label above the caller's clearance on a label change (D198)", { timeout: T }, () => {
  // Every record starts at `public`, so each change is a raise: allowed for editors (D51) and
  // decided by the clearance alone.
  it.each(EDITOR_CASES)('%s raising a %s, clearance %s, to %s', async (role, kind, clearance, label) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), kind, validInput(kind, { label: 'public' }));
    const got = await outcome(svc.update(caller(org, role as Role, clearance), kind, rec.id, { label, version: 1 }));
    const allowed = isVisible(clearance, label);
    expect(got).toBe(allowed ? 'ok' : 403);
    const node = await storedNode(env, org.id, kind, rec.id);
    expect(node?.['sensitivity']).toBe(allowed ? label : 'public');
    expect(node?.['version']).toBe(allowed ? 2 : 1);
  });

  it.each(LABELS)('an API key (clearance internal) raising a risk to %s', async (label) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk', { label: 'public' }));
    const got = await outcome(svc.update(keyCaller(org, 'risk_manager'), 'risk', rec.id, { label, version: 1 }));
    expect(got).toBe(isVisible('internal', label) ? 'ok' : 403);
  });
});

describe('raise and lower (D51, canChangeLabel)', { timeout: T }, () => {
  const PAIRS = LABELS.flatMap((from) => LABELS.map((to) => [from, to] as const));
  const CASES = (['admin', 'risk_manager'] as const).flatMap((role) =>
    PAIRS.map(([from, to]) => [role, from, to] as const),
  );

  it.each(CASES)('%s changing a risk from %s to %s (clearance restricted)', async (role, from, to) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk', { label: from }));
    const got = await outcome(svc.update(caller(org, role), 'risk', rec.id, { label: to, version: 1 }));
    const allowed = canChangeLabel(role, from, to);
    expect(got).toBe(allowed ? 'ok' : 403);
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['sensitivity']).toBe(allowed ? to : from);
  });

  it('a Risk Manager lowering a label is 403 forbidden, and nothing else in the body is saved', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk', { label: 'confidential' }));
    await refusedWith(
      svc.update(caller(org, 'risk_manager'), 'risk', rec.id, { label: 'internal', name: uniqueName('x'), version: 1 }),
      403,
      'forbidden',
    );
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['sensitivity']).toBe('confidential');
    expect(node?.['name']).toBe(rec.name);
    expect(node?.['version']).toBe(1);
  });

  it('a Control Owner may raise the label of their own control', async () => {
    const svc = await service(env);
    const owner = org.users.byRole.control_owner;
    const rec = await svc.create(caller(org, 'admin'), 'control', validInput('control', { label: 'internal', owner }));
    const out = await svc.update(caller(org, 'control_owner'), 'control', rec.id, {
      label: 'confidential',
      version: 1,
    });
    expect(out.label).toBe('confidential');
  });

  it('a Control Owner may not lower the label of their own control', async () => {
    const svc = await service(env);
    const owner = org.users.byRole.control_owner;
    const rec = await svc.create(
      caller(org, 'admin'),
      'control',
      validInput('control', { label: 'confidential', owner }),
    );
    await refusedWith(
      svc.update(caller(org, 'control_owner'), 'control', rec.id, { label: 'internal', version: 1 }),
      403,
      'forbidden',
    );
    expect((await storedNode(env, org.id, 'control', rec.id))?.['sensitivity']).toBe('confidential');
  });
});
