// S1-003 criterion 7 (retire), D69: retire sets `status` `retired` with the same version check;
// nothing is ever deleted. A retired record still opens with `get`, and appears in `list` only
// with `status=retired` or `all`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORD_KINDS } from '@grc/shared';
import {
  LONG,
  T,
  caller,
  newTestOrg,
  nodeCount,
  refusedWith,
  service,
  setUpRecords,
  storedNode,
  tearDownRecords,
  validInput,
  type RecEnv,
  type TestOrg,
} from './helpers.js';

let env: RecEnv;
let org: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Retire');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

describe('retire (D69)', { timeout: T }, () => {
  it.each(RECORD_KINDS)('a %s becomes retired, its version goes up by 1, and the node is kept', async (kind) => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), kind, validInput(kind));
    const out = await svc.retire(caller(org, 'admin'), kind, rec.id, 1);
    expect(out).toMatchObject({ id: rec.id, number: rec.number, name: rec.name, status: 'retired', version: 2 });
    expect(await nodeCount(env, org.id, kind, { id: rec.id })).toBe(1);
    expect((await storedNode(env, org.id, kind, rec.id))?.['status']).toBe('retired');
  });

  it('sets updatedBy to the caller', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk'));
    const out = await svc.retire(caller(org, 'risk_manager'), 'risk', rec.id, 1);
    expect(out.updatedBy).toBe(org.users.byRole.risk_manager);
  });

  it('a stale version is 409 stale_version, and the record stays active', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk'));
    await svc.update(caller(org, 'admin'), 'risk', rec.id, { impact: 1, version: 1 });
    await refusedWith(svc.retire(caller(org, 'admin'), 'risk', rec.id, 1), 409, 'stale_version');
    const node = await storedNode(env, org.id, 'risk', rec.id);
    expect(node?.['status']).toBe('active');
    expect(node?.['version']).toBe(2);
  });

  it("an id that doesn't exist is 404 not_found", async () => {
    const svc = await service(env);
    await refusedWith(
      svc.retire(caller(org, 'admin'), 'policy', '00000000-0000-4000-8000-0000000000bb', 1),
      404,
      'not_found',
    );
  });

  it('a retired record still opens with get', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'policy', validInput('policy'));
    await svc.retire(caller(org, 'admin'), 'policy', rec.id, 1);
    const out = await svc.get(caller(org, 'viewer', 'restricted'), 'policy', rec.id);
    expect(out.status).toBe('retired');
  });

  it('a retired record is listed only with status retired or all', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'asset', validInput('asset'));
    await svc.retire(caller(org, 'admin'), 'asset', rec.id, 1);
    const who = caller(org, 'viewer', 'restricted');
    const ids = async (query: Record<string, unknown>): Promise<string[]> =>
      (await svc.list(who, 'asset', { q: rec.name, ...query })).items.map((r) => r.id);
    expect(await ids({})).not.toContain(rec.id);
    expect(await ids({ status: 'active' })).not.toContain(rec.id);
    expect(await ids({ status: 'retired' })).toContain(rec.id);
    expect(await ids({ status: 'all' })).toContain(rec.id);
  });
});
