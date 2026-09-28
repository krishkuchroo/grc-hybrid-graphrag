// S1-003 criterion 2, the Control Owner cases: D50 ("own" means assigned to that user), D199
// (update and retire only their own controls; no create) and D206 (they may hand their control to
// another member of the org; afterwards it is no longer theirs).
// - A hand-over is a normal update: 200 with the new `owner`, one `record.updated` entry with
//   `owner` in `before` and `after`. The old owner then gets 404 on get, update and retire and no
//   longer lists it; the new owner (a Control Owner) sees and edits it.
// - A new owner from another org, or a user ID that doesn't exist, is 400 and nothing changes.
// - A Control Owner changing `owner` on a control they don't own is 404.
// - An owner change by anyone else follows the same member-of-the-org rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  caller,
  newTestOrg,
  outboxEntries,
  refusedWith,
  service,
  setUpRecords,
  storedNode,
  strayUser,
  tearDownRecords,
  uniqueName,
  validInput,
  type Caller,
  type RecEnv,
  type RecordOut,
  type TestOrg,
} from './helpers.js';

let env: RecEnv;
let org: TestOrg;
let other: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Control Owners');
  other = await newTestOrg(env, 'Control Owners Elsewhere');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

function co1(): Caller {
  return caller(org, 'control_owner');
}

function co2(): Caller {
  return caller(org, 'control_owner', 'restricted', org.users.controlOwner2);
}

/** A fresh control made by the Admin, owned by `owner`. */
async function control(owner: string, extra: Record<string, unknown> = {}): Promise<RecordOut> {
  const svc = await service(env);
  return svc.create(caller(org, 'admin'), 'control', validInput('control', { owner, label: 'internal', ...extra }));
}

async function expectUnchanged(rec: RecordOut): Promise<void> {
  const node = await storedNode(env, org.id, 'control', rec.id);
  expect(node?.['owner']).toBe(rec.owner);
  expect(node?.['version']).toBe(rec.version);
  expect(node?.['name']).toBe(rec.name);
}

describe('own and not own (D50, D199)', { timeout: T }, () => {
  it('a Control Owner reads, updates and retires a control they own', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    expect((await svc.get(co1(), 'control', rec.id)).id).toBe(rec.id);
    const updated = await svc.update(co1(), 'control', rec.id, { controlStatus: 'planned', version: 1 });
    expect(updated.controlStatus).toBe('planned');
    expect(updated.version).toBe(2);
    expect((await svc.retire(co1(), 'control', rec.id, 2)).status).toBe('retired');
  });

  it("a control they don't own is 404 on get, update and retire, and unchanged", async () => {
    const svc = await service(env);
    const rec = await control(co2().userId);
    await refusedWith(svc.get(co1(), 'control', rec.id), 404, 'not_found');
    await refusedWith(svc.update(co1(), 'control', rec.id, { name: uniqueName('x'), version: 1 }), 404, 'not_found');
    await refusedWith(svc.retire(co1(), 'control', rec.id, 1), 404, 'not_found');
    await expectUnchanged(rec);
  });

  it("their list holds their own controls and none of anyone else's", async () => {
    const svc = await service(env);
    const tag = uniqueName('co-list').replace(/\s+/g, '-');
    const mine = await control(co1().userId, { name: `${tag} mine` });
    const theirs = await control(co2().userId, { name: `${tag} theirs` });
    const admins = await control(org.adminId, { name: `${tag} admin` });
    const page = await svc.list(co1(), 'control', { q: tag, pageSize: 100 });
    expect(page.items.map((r) => r.id)).toEqual([mine.id]);
    expect(page.total).toBe(1);
    const ids = page.items.map((r) => r.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(admins.id);
  });

  it('a Control Owner creating a control is 403, and nothing is saved (D199)', async () => {
    const svc = await service(env);
    const input = validInput('control');
    await refusedWith(svc.create(co1(), 'control', input), 403, 'forbidden');
    const listed = await svc.list(caller(org, 'admin'), 'control', { q: String(input['name']), status: 'all' });
    expect(listed.total).toBe(0);
  });
});

describe('handing a control over (D206)', { timeout: T }, () => {
  it('answers with the saved record and the new owner', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    const out = await svc.update(co1(), 'control', rec.id, { owner: co2().userId, version: 1 });
    expect(out.owner).toBe(co2().userId);
    expect(out.version).toBe(2);
    expect(out.updatedBy).toBe(co1().userId);
    expect((await storedNode(env, org.id, 'control', rec.id))?.['owner']).toBe(co2().userId);
  });

  it('may change other fields in the same update', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    const name = uniqueName('handed over');
    const out = await svc.update(co1(), 'control', rec.id, {
      name,
      controlStatus: 'not_implemented',
      owner: co2().userId,
      version: 1,
    });
    expect(out).toMatchObject({ name, controlStatus: 'not_implemented', owner: co2().userId, version: 2 });
  });

  it('afterwards the old owner gets 404 on get, update and retire, and no longer lists it', async () => {
    const svc = await service(env);
    const tag = uniqueName('handover').replace(/\s+/g, '-');
    const rec = await control(co1().userId, { name: `${tag} control` });
    await svc.update(co1(), 'control', rec.id, { owner: co2().userId, version: 1 });
    await refusedWith(svc.get(co1(), 'control', rec.id), 404, 'not_found');
    await refusedWith(svc.update(co1(), 'control', rec.id, { name: uniqueName('back'), version: 2 }), 404, 'not_found');
    await refusedWith(svc.retire(co1(), 'control', rec.id, 2), 404, 'not_found');
    const page = await svc.list(co1(), 'control', { q: tag, status: 'all', pageSize: 100 });
    expect(page.items.map((r) => r.id)).not.toContain(rec.id);
    const node = await storedNode(env, org.id, 'control', rec.id);
    expect(node?.['owner']).toBe(co2().userId);
    expect(node?.['version']).toBe(2);
    expect(node?.['status']).toBe('active');
  });

  it('afterwards the new owner sees it, lists it and edits it', async () => {
    const svc = await service(env);
    const tag = uniqueName('handover-new').replace(/\s+/g, '-');
    const rec = await control(co1().userId, { name: `${tag} control` });
    await svc.update(co1(), 'control', rec.id, { owner: co2().userId, version: 1 });
    expect((await svc.get(co2(), 'control', rec.id)).owner).toBe(co2().userId);
    const page = await svc.list(co2(), 'control', { q: tag, pageSize: 100 });
    expect(page.items.map((r) => r.id)).toContain(rec.id);
    const edited = await svc.update(co2(), 'control', rec.id, { controlStatus: 'implemented', version: 2 });
    expect(edited.version).toBe(3);
  });

  it('writes one record.updated entry with owner in before and after', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    await svc.update(co1(), 'control', rec.id, { owner: co2().userId, version: 1 });
    const updates = (await outboxEntries(env, org.id, rec.id)).filter((e) => e.action === 'record.updated');
    expect(updates).toHaveLength(1);
    const entry = updates[0]!;
    expect(entry.targetType).toBe('control');
    expect(entry.actorType).toBe('user');
    expect(entry.actorId).toBe(co1().userId);
    expect(entry.before?.['owner']).toBe(co1().userId);
    expect(entry.after?.['owner']).toBe(co2().userId);
  });

  it('to a member of another org is 400, and nothing changes', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    const outsider = other.users.byRole.control_owner;
    await refusedWith(svc.update(co1(), 'control', rec.id, { owner: outsider, version: 1 }), 400);
    await expectUnchanged(rec);
    expect((await outboxEntries(env, org.id, rec.id)).filter((e) => e.action === 'record.updated')).toHaveLength(0);
  });

  it('to a user of no org is 400, and nothing changes', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    await refusedWith(svc.update(co1(), 'control', rec.id, { owner: await strayUser(env, 'No Org'), version: 1 }), 400);
    await expectUnchanged(rec);
  });

  it("to a user ID that doesn't exist is 400, and nothing changes", async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await refusedWith(svc.update(co1(), 'control', rec.id, { owner: ghost, version: 1 }), 400);
    await expectUnchanged(rec);
  });

  it("changing owner on a control they don't own is 404, and nothing changes", async () => {
    const svc = await service(env);
    const rec = await control(co2().userId);
    await refusedWith(svc.update(co1(), 'control', rec.id, { owner: co1().userId, version: 1 }), 404, 'not_found');
    await expectUnchanged(rec);
  });
});

describe('owner changes by anyone else follow the same rule', { timeout: T }, () => {
  it('a Compliance Manager may move a control to another member', async () => {
    const svc = await service(env);
    const rec = await control(co1().userId);
    const out = await svc.update(caller(org, 'compliance_manager'), 'control', rec.id, {
      owner: co2().userId,
      version: 1,
    });
    expect(out.owner).toBe(co2().userId);
  });

  it.each(['admin', 'risk_manager'] as const)('an owner outside the org is 400 for a %s on a risk', async (role) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk'));
    const outsider = other.users.byRole.risk_manager;
    await refusedWith(svc.update(caller(org, role), 'risk', rec.id, { owner: outsider, version: 1 }), 400);
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['owner']).toBe(rec.owner);
    expect(node?.['version']).toBe(1);
  });
});
