// S1-004 criterion 2, the hand-over through the routes (D206, D199, D50).
// A Control Owner's PATCH /api/v1/controls/:id on a control they own, with a new `owner` who is a
// member of the org, is 200 with the saved record. Afterwards that Control Owner gets 404 on GET,
// PATCH and POST …/retire for it, and it's gone from their GET /api/v1/controls; the new owner (a
// Control Owner) gets 200 on it and sees it in their list. A new `owner` from another org, or an
// unknown user ID, is 400 and the control is unchanged. Changing `owner` on a control they don't own
// is 404.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  expectRefused,
  expectUnchanged,
  getR,
  json,
  listIds,
  newApiOrg,
  patchR,
  person,
  retireR,
  seed,
  setUpRecordsApi,
  show,
  storedNode,
  tearDownRecordsApi,
  type ApiEnv,
  type Org,
  type RecordOut,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let elsewhere: Org;
let admin: SignedIn;
let co1: SignedIn;
let co2: SignedIn;
let outsider: SignedIn;

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api Hand Over');
  elsewhere = await newApiOrg(env, 'Records Api Hand Over Elsewhere');
  admin = await person(env, org, 'admin');
  co1 = await person(env, org, 'control_owner');
  co2 = await person(env, org, 'control_owner');
  outsider = await person(env, elsewhere, 'control_owner');
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

function control(owner: SignedIn): Promise<RecordOut> {
  return seed(e(), admin, 'control', { owner: owner.user.id, label: 'internal' });
}

describe('D206: a Control Owner hands their control to another Control Owner', { timeout: T }, () => {
  it('PATCH with the new owner is 200 with the saved record', async () => {
    const rec = await control(co1);
    const res = await patchR(e(), co1, 'control', rec.id, { owner: co2.user.id, version: rec.version });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(res)).toMatchObject({ id: rec.id, owner: co2.user.id, version: rec.version + 1 });
    const node = await storedNode(e(), org.id, 'control', rec.id);
    expect(node?.['owner']).toBe(co2.user.id);
  });

  it('afterwards the old owner gets 404 on GET, PATCH and retire, and no longer lists it', async () => {
    const rec = await control(co1);
    const handed = await patchR(e(), co1, 'control', rec.id, { owner: co2.user.id, version: rec.version });
    expect(handed.statusCode, show(handed)).toBe(200);
    const v = rec.version + 1;

    expectRefused(await getR(e(), co1, 'control', rec.id), 404, 'not_found');
    expectRefused(
      await patchR(e(), co1, 'control', rec.id, { controlStatus: 'planned', version: v }),
      404,
      'not_found',
    );
    expectRefused(await retireR(e(), co1, 'control', rec.id, v), 404, 'not_found');
    expect(await listIds(e(), co1, 'control')).not.toContain(rec.id);
    await expectUnchanged(e(), org.id, 'control', { ...rec, owner: co2.user.id, version: v });
  });

  it('afterwards the new owner sees it, lists it and edits it', async () => {
    const rec = await control(co1);
    const handed = await patchR(e(), co1, 'control', rec.id, { owner: co2.user.id, version: rec.version });
    expect(handed.statusCode, show(handed)).toBe(200);
    const v = rec.version + 1;

    const got = await getR(e(), co2, 'control', rec.id);
    expect(got.statusCode, show(got)).toBe(200);
    expect(json(got)).toMatchObject({ id: rec.id, owner: co2.user.id });
    expect(await listIds(e(), co2, 'control')).toContain(rec.id);
    const edited = await patchR(e(), co2, 'control', rec.id, { controlStatus: 'planned', version: v });
    expect(edited.statusCode, show(edited)).toBe(200);
    expect(json(edited)).toMatchObject({ controlStatus: 'planned', version: v + 1 });
  });

  it('a new owner from another org is 400 and the control is unchanged', async () => {
    const rec = await control(co1);
    const res = await patchR(e(), co1, 'control', rec.id, { owner: outsider.user.id, version: rec.version });
    expectRefused(res, 400, 'validation_failed');
    await expectUnchanged(e(), org.id, 'control', rec);
    expect((await getR(e(), co1, 'control', rec.id)).statusCode).toBe(200);
  });

  it('an unknown user ID as the new owner is 400 and the control is unchanged', async () => {
    const rec = await control(co1);
    const res = await patchR(e(), co1, 'control', rec.id, { owner: randomUUID(), version: rec.version });
    expectRefused(res, 400, 'validation_failed');
    await expectUnchanged(e(), org.id, 'control', rec);
  });

  it("changing owner on a control they don't own is 404 and the control is unchanged", async () => {
    const rec = await control(co2);
    const res = await patchR(e(), co1, 'control', rec.id, { owner: co1.user.id, version: rec.version });
    expectRefused(res, 404, 'not_found');
    await expectUnchanged(e(), org.id, 'control', rec);
  });
});
