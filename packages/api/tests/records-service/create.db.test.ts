// S1-003 criterion 1 (create), D68, D69, D51 defaults, D196 numbers, D197 rating.
// - A new lowercase UUID; the next number for that org and type from a `(:RecordCounter {kind})`
//   node in the same write transaction, starting at FIRST_NUMBER (1001). 50 creates at once give 50
//   different numbers with no gaps; two orgs and two types count separately.
// - status `active`, version 1; the label from `defaultLabel` unless given, saved as `sensitivity`;
//   the owner is the caller unless given, and must be a member of the same org (400); an API-key
//   caller must name an owner.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIRST_NUMBER,
  RECORD_KINDS,
  defaultLabel,
  formatNumber,
  parseNumber,
  recordSchemas,
  riskRating,
} from '@grc/shared';
import {
  LONG,
  T,
  caller,
  counterNodes,
  keyCaller,
  newTestOrg,
  nodeCount,
  refusedWith,
  service,
  setUpRecords,
  storedNode,
  strayUser,
  tearDownRecords,
  validInput,
  type RecEnv,
  type RecordKind,
  type TestOrg,
} from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let env: RecEnv;
let fresh: TestOrg; // only the first-number test makes records here
let fresh2: TestOrg; // likewise: a second org, to show two orgs count separately
let burst: TestOrg; // only the 50-at-once test makes records here
let a: TestOrg;
let b: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  fresh = await newTestOrg(env, 'Create Fresh');
  fresh2 = await newTestOrg(env, 'Create Fresh Two');
  burst = await newTestOrg(env, 'Create Burst');
  a = await newTestOrg(env, 'Create A');
  b = await newTestOrg(env, 'Create B');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

describe('numbers (D196)', { timeout: T }, () => {
  // Every type in two fresh orgs starts at 1001: two orgs and two types count separately.
  it.each(RECORD_KINDS)('the first %s in each of two fresh orgs gets …0001001', async (kind) => {
    const svc = await service(env);
    const one = await svc.create(caller(fresh, 'admin'), kind, validInput(kind));
    const two = await svc.create(caller(fresh2, 'admin'), kind, validInput(kind));
    expect(one.number).toBe(formatNumber(kind, FIRST_NUMBER));
    expect(two.number).toBe(formatNumber(kind, FIRST_NUMBER));
  });

  it('the next create of the same type in the same org gets the next number', async () => {
    const svc = await service(env);
    const first = await svc.create(caller(a, 'admin'), 'policy', validInput('policy'));
    const second = await svc.create(caller(a, 'admin'), 'policy', validInput('policy'));
    const n1 = parseNumber(first.number);
    expect(n1?.kind).toBe('policy');
    expect(parseNumber(second.number)).toEqual({ kind: 'policy', n: (n1?.n ?? 0) + 1 });
  });

  it("a create in another org doesn't move this org's count", async () => {
    const svc = await service(env);
    const first = await svc.create(caller(a, 'admin'), 'incident', validInput('incident'));
    await svc.create(caller(b, 'admin'), 'incident', validInput('incident'));
    const second = await svc.create(caller(a, 'admin'), 'incident', validInput('incident'));
    expect(parseNumber(second.number)?.n).toBe((parseNumber(first.number)?.n ?? 0) + 1);
  });

  it('keeps the count in one RecordCounter node per type in the org database', async () => {
    const svc = await service(env);
    await svc.create(caller(a, 'admin'), 'asset', validInput('asset'));
    await svc.create(caller(a, 'admin'), 'asset', validInput('asset'));
    expect(await counterNodes(env, a.id, 'asset')).toBe(1);
  });

  it('50 creates at once in one org give 50 different numbers with no gaps', async () => {
    const svc = await service(env);
    const made = await Promise.all(
      Array.from({ length: 50 }, () => svc.create(caller(burst, 'admin'), 'risk', validInput('risk'))),
    );
    const numbers = made.map((r) => r.number).sort();
    const expected = Array.from({ length: 50 }, (_, i) => formatNumber('risk', FIRST_NUMBER + i));
    expect(numbers).toEqual(expected);
    expect(new Set(made.map((r) => r.id)).size).toBe(50);
  });
});

describe('the new record', { timeout: T }, () => {
  it.each(RECORD_KINDS)('a %s gets a lowercase UUID, status active, version 1, origin manual', async (kind) => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'admin'), kind, validInput(kind));
    expect(out.id).toMatch(UUID);
    expect(out.status).toBe('active');
    expect(out.version).toBe(1);
    expect(out.origin).toBe('manual');
    expect(out.sourceIds).toEqual([]);
  });

  it.each(RECORD_KINDS)('a %s is returned in the shared record shape', async (kind) => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'admin'), kind, validInput(kind));
    const parsed = recordSchemas[kind].safeParse(out);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it.each(RECORD_KINDS)('a %s is saved in the org database with its fields', async (kind) => {
    const svc = await service(env);
    const input = validInput(kind);
    const out = await svc.create(caller(a, 'admin'), kind, input);
    const node = await storedNode(env, a.id, kind, out.id);
    expect(node, 'no node with that id').toBeDefined();
    expect(node).toMatchObject({
      id: out.id,
      number: out.number,
      name: input['name'],
      status: 'active',
      version: 1,
      owner: a.adminId,
      createdBy: a.adminId,
      updatedBy: a.adminId,
      origin: 'manual',
    });
  });

  it('keeps the created and updated times and who made it', async () => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'risk_manager'), 'risk', validInput('risk'));
    expect(out.createdBy).toBe(a.users.byRole.risk_manager);
    expect(out.updatedBy).toBe(a.users.byRole.risk_manager);
    expect(Number.isNaN(Date.parse(out.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(out.updatedAt))).toBe(false);
  });

  it('a risk carries its rating (D197)', async () => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'admin'), 'risk', validInput('risk', { impact: 4, likelihood: 5 }));
    expect(out.rating).toEqual(riskRating(4, 5));
    expect(out.rating).toEqual({ score: 20, band: 'critical' });
  });
});

describe('labels on create (D51)', { timeout: T }, () => {
  it.each([
    ['risk', {}],
    ['control', {}],
    ['policy', {}],
    ['incident', {}],
    ['asset', { dataClassification: 'confidential' }],
    ['asset', { dataClassification: 'public' }],
  ] as [RecordKind, Record<string, unknown>][])('a %s without a label gets defaultLabel (%j)', async (kind, extra) => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'admin'), kind, validInput(kind, extra));
    const expected = defaultLabel(kind, extra as never);
    expect(out.label).toBe(expected);
    expect((await storedNode(env, a.id, kind, out.id))?.['sensitivity']).toBe(expected);
  });

  it('a given label is kept, and saved as `sensitivity`', async () => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'admin'), 'risk', validInput('risk', { label: 'restricted' }));
    expect(out.label).toBe('restricted');
    expect((await storedNode(env, a.id, 'risk', out.id))?.['sensitivity']).toBe('restricted');
  });
});

describe('owner on create', { timeout: T }, () => {
  it('is the caller when none is given', async () => {
    const svc = await service(env);
    const out = await svc.create(caller(a, 'compliance_manager'), 'policy', validInput('policy'));
    expect(out.owner).toBe(a.users.byRole.compliance_manager);
  });

  it('is the given member of the same org', async () => {
    const svc = await service(env);
    const owner = a.users.byRole.control_owner;
    const out = await svc.create(caller(a, 'admin'), 'control', validInput('control', { owner }));
    expect(out.owner).toBe(owner);
    expect((await storedNode(env, a.id, 'control', out.id))?.['owner']).toBe(owner);
  });

  it('is 400 for a member of another org, and nothing is saved', async () => {
    const svc = await service(env);
    const input = validInput('risk', { owner: b.users.byRole.risk_manager });
    await refusedWith(svc.create(caller(a, 'admin'), 'risk', input), 400);
    expect(await nodeCount(env, a.id, 'risk', { name: input['name'] })).toBe(0);
  });

  it('is 400 for a user of no org, and nothing is saved', async () => {
    const svc = await service(env);
    const input = validInput('risk', { owner: await strayUser(env, 'Nobody Anywhere') });
    await refusedWith(svc.create(caller(a, 'admin'), 'risk', input), 400);
    expect(await nodeCount(env, a.id, 'risk', { name: input['name'] })).toBe(0);
  });

  it("is 400 for a user ID that doesn't exist, and nothing is saved", async () => {
    const svc = await service(env);
    const input = validInput('risk', { owner: '00000000-0000-4000-8000-000000000000' });
    await refusedWith(svc.create(caller(a, 'admin'), 'risk', input), 400);
    expect(await nodeCount(env, a.id, 'risk', { name: input['name'] })).toBe(0);
  });

  it('an API-key caller without an owner is 400, and nothing is saved', async () => {
    const svc = await service(env);
    const input = validInput('risk');
    await refusedWith(svc.create(keyCaller(a, 'risk_manager'), 'risk', input), 400);
    expect(await nodeCount(env, a.id, 'risk', { name: input['name'] })).toBe(0);
  });

  it('an API-key caller naming a member of its org as owner creates the record', async () => {
    const svc = await service(env);
    const owner = a.users.byRole.risk_manager;
    const out = await svc.create(keyCaller(a, 'risk_manager'), 'risk', validInput('risk', { owner }));
    expect(out.owner).toBe(owner);
  });
});

describe('input checks', { timeout: T }, () => {
  it.each([
    ['an empty name', { name: '' }],
    ['an unknown field', { colour: 'red' }],
    ['an id', { id: '00000000-0000-4000-8000-000000000001' }],
    ['a status', { status: 'retired' }],
    ['an impact off the scale', { impact: 6 }],
    ['an unknown label', { label: 'secret' }],
  ])('%s is 400 validation_failed, and nothing is saved', async (_what, extra) => {
    const svc = await service(env);
    const input = validInput('risk', extra);
    await refusedWith(svc.create(caller(a, 'admin'), 'risk', input), 400, 'validation_failed');
    if (typeof input['name'] === 'string' && input['name'] !== '') {
      expect(await nodeCount(env, a.id, 'risk', { name: input['name'] })).toBe(0);
    }
  });
});
