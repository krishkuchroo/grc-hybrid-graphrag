// S1-004 routes table (D47: paging, filters, sorting, one error format): GET /api/v1/P takes the
// S1-003 list query from the query string and answers `Paged<Record>`; POST and PATCH take the
// S1-001 create and update schemas. Query-string values arrive as text, so page numbers are
// coerced (M0-007 `pageQuerySchema`). An unknown filter or sort field, or an unknown body field, is
// 400 `validation_failed` in the one error format.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  countNamed,
  createR,
  expectRefused,
  expectUnchanged,
  json,
  listR,
  newApiOrg,
  patchR,
  person,
  seed,
  setUpRecordsApi,
  show,
  tearDownRecordsApi,
  validInput,
  type ApiEnv,
  type Org,
  type RecordOut,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let admin: SignedIn;
let other: SignedIn;
const TAG = `lq${Date.now().toString(36)}`;
const risks: RecordOut[] = [];

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api List Query');
  admin = await person(env, org, 'admin', 'restricted');
  other = await person(env, org, 'risk_manager', 'restricted');
  // Five risks with names in a known order, scores 1, 4, 9, 16, 25, two owned by `other`.
  for (const [i, n] of [1, 2, 3, 4, 5].entries()) {
    risks.push(
      await seed(env, admin, 'risk', {
        name: `${TAG} ${String.fromCharCode(101 - i)} risk`,
        impact: n,
        likelihood: n,
        label: i === 0 ? 'confidential' : 'internal',
        ...(i < 2 ? { owner: other.user.id } : {}),
      }),
    );
  }
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

type Page = { items: RecordOut[]; page: number; pageSize: number; total: number };

async function page(query: string): Promise<Page> {
  const res = await listR(e(), admin, 'risk', `?q=${TAG}&${query}`);
  expect(res.statusCode, show(res)).toBe(200);
  return json(res) as unknown as Page;
}

describe('GET /api/v1/risks takes the list query from the query string', { timeout: T }, () => {
  it('answers Paged<Record>, 25 a page by default', async () => {
    const p = await page('');
    expect(p).toMatchObject({ page: 1, pageSize: 25, total: 5 });
    expect(p.items).toHaveLength(5);
  });

  it('pages with page and pageSize (text coerced to numbers)', async () => {
    const first = await page('pageSize=2&page=1');
    const third = await page('pageSize=2&page=3');
    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(first.items).toHaveLength(2);
    expect(third.items).toHaveLength(1);
  });

  it('sorts by name, ascending and descending', async () => {
    const asc = (await page('sort=name')).items.map((r) => r.id);
    const desc = (await page('sort=-name')).items.map((r) => r.id);
    expect(asc).toEqual([...risks].reverse().map((r) => r.id));
    expect(desc).toEqual(risks.map((r) => r.id));
  });

  it('sorts risks by score', async () => {
    const desc = (await page('sort=-score')).items.map((r) => r.id);
    expect(desc).toEqual([...risks].reverse().map((r) => r.id));
  });

  it('filters by owner, label and band', async () => {
    expect((await page(`owner=${other.user.id}`)).items.map((r) => r.id).sort()).toEqual(
      [risks[0]!.id, risks[1]!.id].sort(),
    );
    expect((await page('label=confidential')).items.map((r) => r.id)).toEqual([risks[0]!.id]);
    const band = (risks[4]!.rating as { band: string }).band;
    expect((await page(`band=${band}`)).items.map((r) => r.id)).toContain(risks[4]!.id);
  });

  it.each(['bogus=1', 'sort=colour', 'sort=-bogus', 'status=deleted', 'page=0', 'pageSize=101'])(
    '%s is 400 validation_failed in the one error format',
    async (query) => {
      expectRefused(await listR(e(), admin, 'risk', `?${query}`), 400, 'validation_failed');
    },
  );

  it('a filter of another type (severity on risks) is 400', async () => {
    expectRefused(await listR(e(), admin, 'risk', '?severity=high'), 400, 'validation_failed');
  });
});

describe('bodies follow the S1-001 schemas', { timeout: T }, () => {
  it('POST with a server-set field is 400, nothing saved', async () => {
    const body = validInput('risk', { version: 7 });
    expectRefused(await createR(e(), admin, 'risk', body), 400, 'validation_failed');
    expect(await countNamed(e(), org.id, 'risk', body.name as string)).toBe(0);
  });

  it('POST with a bad value is 400, nothing saved', async () => {
    const body = validInput('risk', { impact: 9 });
    expectRefused(await createR(e(), admin, 'risk', body), 400, 'validation_failed');
    expect(await countNamed(e(), org.id, 'risk', body.name as string)).toBe(0);
  });

  it('PATCH with an unknown field is 400, nothing changes', async () => {
    const rec = await seed(e(), admin, 'risk');
    expectRefused(
      await patchR(e(), admin, 'risk', rec.id, { status: 'retired', version: 1 }),
      400,
      'validation_failed',
    );
    await expectUnchanged(e(), org.id, 'risk', rec);
  });
});
