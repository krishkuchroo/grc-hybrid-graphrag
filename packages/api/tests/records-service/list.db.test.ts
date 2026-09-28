// S1-003 criterion 4 (list), D47 (paging, filters, sorting, one error format), D197 (the risk band).
// - Pages with `pageQuerySchema` (page 1 and 25 per page by default).
// - Filters: `status` (`active` by default, `retired`, `all`), `owner`, `label`, each type's list
//   fields (`assetType`, `criticality`, `controlStatus`, `framework`, `severity`, `incidentStatus`,
//   the risk `band`), and `q`, a case-insensitive "contains" on name or number.
// - Sorts by `number` (default), `name`, `updatedAt`, and `score` for risks; a leading `-` sorts
//   descending (the reading these tests fix for "ascending or descending").
// - An unknown filter or sort field is 400.
// The fixtures live in one org that nothing else writes to, so every list is exact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  caller,
  newTestOrg,
  refusedWith,
  service,
  setUpRecords,
  tearDownRecords,
  validInput,
  type RecEnv,
  type RecordKind,
  type RecordOut,
  type TestOrg,
} from './helpers.js';

let env: RecEnv;
let org: TestOrg;

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Lists');
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

interface Risks {
  alpha: RecordOut; // 1 x 1 = 1 low, public, Admin
  bravo: RecordOut; // 3 x 3 = 9 medium, internal, Risk Manager; updated last
  charlie: RecordOut; // 4 x 4 = 16 high, confidential, Admin
  delta: RecordOut; // 5 x 5 = 25 critical, public, Risk Manager
  echo: RecordOut; // 2 x 2 = 4 low, retired
}

let risks: Promise<Risks> | undefined;
/** The risk fixtures, made in this order (numbers 1001 to 1005). Made once, inside the tests. */
function riskFixtures(): Promise<Risks> {
  risks ??= (async () => {
    const svc = await service(env);
    const admin = caller(org, 'admin');
    const rm = org.users.byRole.risk_manager;
    const make = (name: string, n: number, label: string, owner: string): Promise<RecordOut> =>
      svc.create(admin, 'risk', validInput('risk', { name, impact: n, likelihood: n, label, owner }));
    const alpha = await make('Alpha risk', 1, 'public', org.adminId);
    const bravo = await make('Bravo risk', 3, 'internal', rm);
    const charlie = await make('Charlie risk', 4, 'confidential', org.adminId);
    const delta = await make('Delta risk', 5, 'public', rm);
    const echo = await make('Echo risk', 2, 'public', org.adminId);
    const retiredEcho = await svc.retire(admin, 'risk', echo.id, echo.version);
    const touchedBravo = await svc.update(admin, 'risk', bravo.id, { financialExposure: 1, version: bravo.version });
    return { alpha, bravo: touchedBravo, charlie, delta, echo: retiredEcho };
  })();
  return risks;
}

const others = new Map<RecordKind, Promise<RecordOut[]>>();
/** Two records of `kind` with different list-field values. */
function otherFixtures(kind: 'asset' | 'control' | 'incident'): Promise<RecordOut[]> {
  let p = others.get(kind);
  if (!p) {
    const values: Record<typeof kind, Record<string, unknown>[]> = {
      asset: [
        { name: 'Mail server', assetType: 'server', criticality: 'critical' },
        { name: 'Payroll database', assetType: 'database', criticality: 'low' },
      ],
      control: [
        { name: 'Access reviews', controlStatus: 'implemented', framework: 'NIST 800-53' },
        { name: 'Backup testing', controlStatus: 'planned', framework: 'ISO 27001' },
      ],
      incident: [
        { name: 'Phishing wave', severity: 'high', incidentStatus: 'new' },
        { name: 'Lost laptop', severity: 'low', incidentStatus: 'closed' },
      ],
    };
    p = (async () => {
      const svc = await service(env);
      const made: RecordOut[] = [];
      for (const v of values[kind]) made.push(await svc.create(caller(org, 'admin'), kind, validInput(kind, v)));
      return made;
    })();
    others.set(kind, p);
  }
  return p;
}

async function names(kind: RecordKind, query: Record<string, unknown>): Promise<string[]> {
  const svc = await service(env);
  const page = await svc.list(caller(org, 'admin'), kind, query);
  return page.items.map((r) => r.name);
}

describe('paging (D47)', { timeout: T }, () => {
  it('defaults to page 1, 25 per page, active records by number', async () => {
    const r = await riskFixtures();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'admin'), 'risk', {});
    expect(page).toMatchObject({ page: 1, pageSize: 25, total: 4 });
    expect(page.items.map((x) => x.id)).toEqual([r.alpha.id, r.bravo.id, r.charlie.id, r.delta.id]);
  });

  it('returns the asked-for page, with the total of all pages', async () => {
    const r = await riskFixtures();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'admin'), 'risk', { page: 2, pageSize: 2 });
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 4 });
    expect(page.items.map((x) => x.id)).toEqual([r.charlie.id, r.delta.id]);
  });

  it('a page past the end is empty and keeps the total', async () => {
    await riskFixtures();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'admin'), 'risk', { page: 3, pageSize: 2 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(4);
  });

  it('accepts page numbers as query-string text', async () => {
    const r = await riskFixtures();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'admin'), 'risk', { page: '1', pageSize: '1' });
    expect(page.items.map((x) => x.id)).toEqual([r.alpha.id]);
  });

  it('each risk in a list carries its rating (D197)', async () => {
    await riskFixtures();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'admin'), 'risk', {});
    expect(page.items.map((x) => x.rating)).toEqual([
      { score: 1, band: 'low' },
      { score: 9, band: 'medium' },
      { score: 16, band: 'high' },
      { score: 25, band: 'critical' },
    ]);
  });
});

describe('filters', { timeout: T }, () => {
  it.each([
    ['status retired', { status: 'retired' }, ['Echo risk']],
    ['status all', { status: 'all' }, ['Alpha risk', 'Bravo risk', 'Charlie risk', 'Delta risk', 'Echo risk']],
    ['status active', { status: 'active' }, ['Alpha risk', 'Bravo risk', 'Charlie risk', 'Delta risk']],
    ['label confidential', { label: 'confidential' }, ['Charlie risk']],
    ['label public', { label: 'public' }, ['Alpha risk', 'Delta risk']],
    ['band high', { band: 'high' }, ['Charlie risk']],
    ['band low', { band: 'low' }, ['Alpha risk']],
    ['band low, all statuses', { band: 'low', status: 'all' }, ['Alpha risk', 'Echo risk']],
    ['band medium', { band: 'medium' }, ['Bravo risk']],
    ['band critical', { band: 'critical' }, ['Delta risk']],
    ['q in any case', { q: 'bRaVo' }, ['Bravo risk']],
    ['q on part of a name', { q: 'lta ri' }, ['Delta risk']],
  ])('risks by %s', async (_what, query, want) => {
    await riskFixtures();
    expect(await names('risk', query)).toEqual(want);
  });

  it('risks by owner', async () => {
    await riskFixtures();
    expect(await names('risk', { owner: org.users.byRole.risk_manager })).toEqual(['Bravo risk', 'Delta risk']);
    expect(await names('risk', { owner: org.adminId })).toEqual(['Alpha risk', 'Charlie risk']);
  });

  it('q matches the number, in any case', async () => {
    const r = await riskFixtures();
    expect(await names('risk', { q: r.charlie.number })).toEqual(['Charlie risk']);
    expect(await names('risk', { q: r.charlie.number.toLowerCase() })).toEqual(['Charlie risk']);
  });

  it('filters combine', async () => {
    await riskFixtures();
    expect(await names('risk', { owner: org.users.byRole.risk_manager, label: 'public' })).toEqual(['Delta risk']);
  });

  it.each([
    ['asset', { assetType: 'database' }, ['Payroll database']],
    ['asset', { criticality: 'critical' }, ['Mail server']],
    ['control', { controlStatus: 'planned' }, ['Backup testing']],
    ['control', { framework: 'NIST 800-53' }, ['Access reviews']],
    ['incident', { severity: 'high' }, ['Phishing wave']],
    ['incident', { incidentStatus: 'closed' }, ['Lost laptop']],
  ] as ['asset' | 'control' | 'incident', Record<string, unknown>, string[]][])(
    '%s by %j',
    async (kind, query, want) => {
      await otherFixtures(kind);
      expect(await names(kind, query)).toEqual(want);
    },
  );
});

describe('sorting', { timeout: T }, () => {
  it.each([
    ['number', ['Alpha risk', 'Bravo risk', 'Charlie risk', 'Delta risk']],
    ['-number', ['Delta risk', 'Charlie risk', 'Bravo risk', 'Alpha risk']],
    ['name', ['Alpha risk', 'Bravo risk', 'Charlie risk', 'Delta risk']],
    ['-name', ['Delta risk', 'Charlie risk', 'Bravo risk', 'Alpha risk']],
    ['score', ['Alpha risk', 'Bravo risk', 'Charlie risk', 'Delta risk']],
    ['-score', ['Delta risk', 'Charlie risk', 'Bravo risk', 'Alpha risk']],
    // Bravo was updated after the others were made.
    ['updatedAt', ['Alpha risk', 'Charlie risk', 'Delta risk', 'Bravo risk']],
    ['-updatedAt', ['Bravo risk', 'Delta risk', 'Charlie risk', 'Alpha risk']],
  ])('risks by %s', async (sort, want) => {
    await riskFixtures();
    expect(await names('risk', { sort })).toEqual(want);
  });

  it('sorting applies before paging', async () => {
    await riskFixtures();
    expect(await names('risk', { sort: '-name', page: 1, pageSize: 2 })).toEqual(['Delta risk', 'Charlie risk']);
  });

  it('other kinds sort by name', async () => {
    await otherFixtures('asset');
    expect(await names('asset', { sort: 'name' })).toEqual(['Mail server', 'Payroll database']);
    expect(await names('asset', { sort: '-name' })).toEqual(['Payroll database', 'Mail server']);
  });
});

describe('bad list queries are 400 (D47)', { timeout: T }, () => {
  it.each([
    ['an unknown filter', 'risk', { colour: 'red' }],
    ['an unknown sort field', 'risk', { sort: 'impact' }],
    ['a bare minus as sort', 'risk', { sort: '-' }],
    ['score on a kind that is not a risk', 'asset', { sort: 'score' }],
    ['band on a kind that is not a risk', 'control', { band: 'high' }],
    ["another type's field", 'risk', { assetType: 'server' }],
    ['an unknown status', 'risk', { status: 'deleted' }],
    ['an unknown band', 'risk', { band: 'severe' }],
    ['an unknown label', 'risk', { label: 'secret' }],
    ['pageSize over 100', 'risk', { pageSize: 101 }],
    ['page 0', 'risk', { page: 0 }],
  ] as [string, RecordKind, Record<string, unknown>][])('%s', async (_what, kind, query) => {
    const svc = await service(env);
    await refusedWith(svc.list(caller(org, 'admin'), kind, query), 400, 'validation_failed');
  });
});
