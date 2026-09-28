// S1-004 criterion 6 (D69, D47): a stale save gives 409 `stale_version` in the one error format,
// and the record is unchanged. Retire keeps the record: it still opens, it is listed only with
// status=retired or all, and nothing is ever deleted. Also the route answers of the brief's table:
// POST 201 with the record, GET/PATCH/retire 200 with the record, each a valid record for its kind.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordSchemas } from '@grc/shared';
import {
  LONG,
  RECORD_KINDS,
  STALE_MESSAGE,
  T,
  createR,
  expectRefused,
  expectUnchanged,
  fieldChange,
  getR,
  json,
  listIds,
  newApiOrg,
  patchR,
  person,
  retireR,
  seed,
  send,
  setUpRecordsApi,
  show,
  storedNode,
  tearDownRecordsApi,
  validInput,
  base,
  type ApiEnv,
  type Org,
  type RecordOut,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let admin: SignedIn;

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api Stale');
  admin = await person(env, org, 'admin', 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

describe('the route answers are records of their kind (D30, D47)', { timeout: T }, () => {
  it.each(RECORD_KINDS)('%s: POST 201, GET, PATCH and retire 200, each a valid record', async (kind) => {
    const created = await createR(e(), admin, kind, validInput(kind));
    expect(created.statusCode, show(created)).toBe(201);
    const rec = recordSchemas[kind].parse(json(created));
    expect(rec.version).toBe(1);

    const got = await getR(e(), admin, kind, rec.id);
    expect(got.statusCode, show(got)).toBe(200);
    expect(recordSchemas[kind].parse(json(got))).toEqual(rec);

    const patched = await patchR(e(), admin, kind, rec.id, { ...fieldChange(kind), version: 1 });
    expect(patched.statusCode, show(patched)).toBe(200);
    expect(recordSchemas[kind].parse(json(patched))).toMatchObject({ ...fieldChange(kind), version: 2 });

    const retired = await retireR(e(), admin, kind, rec.id, 2);
    expect(retired.statusCode, show(retired)).toBe(200);
    expect(recordSchemas[kind].parse(json(retired))).toMatchObject({ status: 'retired', version: 3 });
  });

  it("a risk's answers carry its rating { score, band } (D197)", async () => {
    const res = await createR(e(), admin, 'risk', validInput('risk', { impact: 4, likelihood: 5 }));
    expect(res.statusCode, show(res)).toBe(201);
    expect(json(res).rating).toEqual({ score: 20, band: expect.any(String) });
    const got = await getR(e(), admin, 'risk', (json(res) as { id: string }).id);
    expect(json(got).rating).toEqual(json(res).rating);
  });
});

describe('criterion 6: a stale save is 409 stale_version, and nothing changes (D69, D47)', { timeout: T }, () => {
  it.each(RECORD_KINDS)('%s: PATCH with an old version', async (kind) => {
    const rec = await seed(e(), admin, kind);
    const first = await patchR(e(), admin, kind, rec.id, { ...fieldChange(kind), version: 1 });
    expect(first.statusCode, show(first)).toBe(200);
    const now = json(first) as unknown as RecordOut;

    const stale = await patchR(e(), admin, kind, rec.id, { name: 'stale edit', version: 1 });
    const body = expectRefused(stale, 409, 'stale_version');
    expect(body.error.message).toBe(STALE_MESSAGE);
    await expectUnchanged(e(), org.id, kind, now);
    expect((await storedNode(e(), org.id, kind, rec.id))?.['name']).toBe(rec.name);
  });

  it.each(RECORD_KINDS)('%s: retire with an old version', async (kind) => {
    const rec = await seed(e(), admin, kind);
    const first = await patchR(e(), admin, kind, rec.id, { ...fieldChange(kind), version: 1 });
    expect(first.statusCode, show(first)).toBe(200);
    const now = json(first) as unknown as RecordOut;
    const stale = await retireR(e(), admin, kind, rec.id, 1);
    expect(expectRefused(stale, 409, 'stale_version').error.message).toBe(STALE_MESSAGE);
    await expectUnchanged(e(), org.id, kind, now);
  });

  it('PATCH without a version is 400 validation_failed, and nothing changes', async () => {
    const rec = await seed(e(), admin, 'risk');
    expectRefused(await patchR(e(), admin, 'risk', rec.id, { impact: 5 }), 400, 'validation_failed');
    await expectUnchanged(e(), org.id, 'risk', rec);
  });

  it('retire without a version is 400 validation_failed, and nothing changes', async () => {
    const rec = await seed(e(), admin, 'risk');
    const res = await send(e(), admin, { method: 'POST', url: `${base('risk')}/${rec.id}/retire`, payload: {} });
    expectRefused(res, 400, 'validation_failed');
    await expectUnchanged(e(), org.id, 'risk', rec);
  });
});

describe('criterion 6: retire keeps the record; nothing is ever deleted (D69)', { timeout: T }, () => {
  it.each(RECORD_KINDS)('%s: a retired record still opens, and is listed only with retired or all', async (kind) => {
    const rec = await seed(e(), admin, kind);
    const res = await retireR(e(), admin, kind, rec.id, rec.version);
    expect(res.statusCode, show(res)).toBe(200);

    const got = await getR(e(), admin, kind, rec.id);
    expect(got.statusCode, show(got)).toBe(200);
    expect(json(got)).toMatchObject({ id: rec.id, status: 'retired' });
    expect(await listIds(e(), admin, kind, 'status=active')).not.toContain(rec.id);
    expect(await listIds(e(), admin, kind, ''), 'the default list is active only').not.toContain(rec.id);
    expect(await listIds(e(), admin, kind, 'status=retired')).toContain(rec.id);
    expect(await listIds(e(), admin, kind, 'status=all')).toContain(rec.id);
    expect((await storedNode(e(), org.id, kind, rec.id))?.['status']).toBe('retired');
  });

  it.each(RECORD_KINDS)('%s: there is no DELETE route, and the record stays and still opens', async (kind) => {
    const rec = await seed(e(), admin, kind);
    const res = await send(e(), admin, { method: 'DELETE', url: `${base(kind)}/${rec.id}` });
    expect(res.statusCode, show(res)).toBe(404);
    await expectUnchanged(e(), org.id, kind, rec);
    const got = await getR(e(), admin, kind, rec.id);
    expect(got.statusCode, show(got)).toBe(200);
  });
});
