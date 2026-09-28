// S1-004 criterion 3 (D59, every org pair; D55 the org wall): with 3 orgs, for each ordered pair
// (A, B), A's users get 404 on B's record IDs for every route that takes an ID, B's records never
// appear in A's lists, and A can't make a record owned by B's user (400). B's records stay as they
// were. The 404 looks exactly like the one for an ID that doesn't exist, so nothing leaks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  RECORD_KINDS,
  T,
  UNKNOWN_ID,
  countNamed,
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
  setUpRecordsApi,
  tearDownRecordsApi,
  validInput,
  type ApiEnv,
  type Org,
  type RecordKind,
  type RecordOut,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
const orgs: Org[] = [];
const admins: SignedIn[] = [];
// records[org index][kind]
const records: Record<RecordKind, RecordOut>[] = [];

beforeAll(async () => {
  env = await setUpRecordsApi();
  for (const name of ['Records Api Org A', 'Records Api Org B', 'Records Api Org C']) {
    const org = await newApiOrg(env, name);
    orgs.push(org);
    const admin = await person(env, org, 'admin', 'restricted');
    admins.push(admin);
    const byKind = {} as Record<RecordKind, RecordOut>;
    for (const kind of RECORD_KINDS) byKind[kind] = await seed(env, admin, kind, { label: 'public' });
    records.push(byKind);
  }
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

const PAIRS = [0, 1, 2].flatMap((a) =>
  [0, 1, 2].filter((b) => b !== a).map((b) => ({ a, b, pair: `${'ABC'[a]} -> ${'ABC'[b]}` })),
);
const CASES = PAIRS.flatMap((p) => RECORD_KINDS.map((kind) => ({ ...p, kind })));

describe('criterion 3: every ordered org pair, every route (D55, D59)', { timeout: T }, () => {
  it('covers 6 ordered pairs x 5 kinds', () => {
    expect(CASES).toHaveLength(30);
  });

  it.each(CASES)("$pair $kind: GET :id of B's record is 404", async ({ a, b, kind }) => {
    expectRefused(await getR(e(), admins[a]!, kind, records[b]![kind].id), 404, 'not_found');
  });

  it.each(CASES)("$pair $kind: PATCH B's record is 404, and it is unchanged", async ({ a, b, kind }) => {
    const theirs = records[b]![kind];
    const res = await patchR(e(), admins[a]!, kind, theirs.id, { ...fieldChange(kind), version: theirs.version });
    expectRefused(res, 404, 'not_found');
    await expectUnchanged(e(), orgs[b]!.id, kind, theirs);
  });

  it.each(CASES)("$pair $kind: retiring B's record is 404, and it is unchanged", async ({ a, b, kind }) => {
    const theirs = records[b]![kind];
    expectRefused(await retireR(e(), admins[a]!, kind, theirs.id, theirs.version), 404, 'not_found');
    await expectUnchanged(e(), orgs[b]!.id, kind, theirs);
  });

  it.each(CASES)("$pair $kind: B's records never appear in A's list", async ({ a, b, kind }) => {
    const ids = await listIds(e(), admins[a]!, kind);
    expect(ids).toContain(records[a]![kind].id);
    for (const theirs of records.filter((_, i) => i !== a)) expect(ids).not.toContain(theirs[kind].id);
    expect(ids).not.toContain(records[b]![kind].id);
  });

  it.each(CASES)(
    "$pair $kind: A can't create a record owned by B's user (400), nothing saved",
    async ({ a, b, kind }) => {
      const body = validInput(kind, { label: 'public', owner: admins[b]!.user.id });
      const res = await createR(e(), admins[a]!, kind, body);
      expectRefused(res, 400, 'validation_failed');
      expect(await countNamed(e(), orgs[a]!.id, kind, body.name as string)).toBe(0);
      expect(await countNamed(e(), orgs[b]!.id, kind, body.name as string)).toBe(0);
    },
  );

  it.each(RECORD_KINDS)("%s: another org's ID and an unknown ID get the same answer", async (kind) => {
    const other = await getR(e(), admins[0]!, kind, records[1]![kind].id);
    const unknown = await getR(e(), admins[0]!, kind, UNKNOWN_ID);
    expect(other.statusCode).toBe(unknown.statusCode);
    expect((json(other).error as { code?: string }).code).toBe((json(unknown).error as { code?: string }).code);
    expect((json(other).error as { message?: string }).message).toBe(
      (json(unknown).error as { message?: string }).message,
    );
  });
});
