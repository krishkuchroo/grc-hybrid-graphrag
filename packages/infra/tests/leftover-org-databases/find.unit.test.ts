// S1-014 criterion 6 (D82, D176, D214 (8)): `leftoverOrgDatabases` picks out the throwaway
// `org-<uuid>` Neo4j databases that belong to no live org.
//
// Contract: `packages/infra/scripts/leftover-org-databases.ts` exports
//   `leftoverOrgDatabases(databaseNames: string[], liveOrgIds: string[]): string[]`
// It is pure. It returns, sorted, the names that are exactly `org-<lowercase uuid>` and whose UUID
// is not in `liveOrgIds`. It never returns `neo4j`, `system`, `restore-test`, any other name, or a
// live org's database. Loaded inside each test, so a missing file fails the tests with its name.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(INFRA, 'scripts', 'leftover-org-databases.ts');

type Find = (databaseNames: string[], liveOrgIds: string[]) => string[];

async function load(): Promise<Find> {
  if (!existsSync(MODULE)) throw new Error('packages/infra/scripts/leftover-org-databases.ts does not exist yet');
  const mod = (await import(/* @vite-ignore */ MODULE)) as { leftoverOrgDatabases?: unknown };
  if (typeof mod.leftoverOrgDatabases !== 'function') {
    throw new Error('leftover-org-databases.ts must export leftoverOrgDatabases');
  }
  return mod.leftoverOrgDatabases as Find;
}

// Fixed IDs, so the sort order is known.
const LIVE_A = '11111111-1111-4111-8111-111111111111';
const LIVE_B = '22222222-2222-4222-8222-222222222222';
const GONE_1 = '0aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GONE_2 = 'ffffffff-0000-4000-8000-000000000001';
const GONE_3 = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('leftoverOrgDatabases (criterion 6)', () => {
  it.each<[string, string[], string[], string[]]>([
    ['empty inputs give []', [], [], []],
    ['no databases gives [] even with live orgs', [], [LIVE_A], []],
    ["a live org's database is never returned", [`org-${LIVE_A}`, `org-${LIVE_B}`], [LIVE_A, LIVE_B], []],
    ['neo4j is never returned', ['neo4j'], [], []],
    ['system is never returned', ['system'], [], []],
    ['restore-test is never returned (D214 (8))', ['restore-test'], [], []],
    ['org- plus an upper-case UUID is never returned', [`org-${GONE_1.toUpperCase()}`], [], []],
    ['org- plus a short ID is never returned', ['org-1234', 'org-acme'], [], []],
    ['org- plus a UUID with more after it is never returned', [`org-${GONE_1}-old`, `org-${GONE_1}x`], [], []],
    ['a bare UUID is never returned', [GONE_1], [], []],
    ['a name that only contains org-<uuid> is never returned', [`x-org-${GONE_1}`, `org-org-${GONE_1}`], [], []],
    ['an org-<uuid> with no live org is returned', [`org-${GONE_1}`], [LIVE_A], [`org-${GONE_1}`]],
    [
      'only the leftovers come back from a mixed list',
      ['neo4j', 'system', 'restore-test', `org-${LIVE_A}`, `org-${GONE_1}`, 'org-short', `org-${LIVE_B}`],
      [LIVE_A, LIVE_B],
      [`org-${GONE_1}`],
    ],
    [
      'the result is sorted',
      [`org-${GONE_2}`, `org-${GONE_1}`, `org-${GONE_3}`],
      [],
      [`org-${GONE_1}`, `org-${GONE_3}`, `org-${GONE_2}`],
    ],
  ])('%s', async (_what, names, live, want) => {
    const find = await load();
    expect(find(names, live)).toEqual(want);
  });

  it('leaves its inputs unchanged', async () => {
    const find = await load();
    const names = [`org-${GONE_2}`, `org-${GONE_1}`, 'neo4j'];
    const live = [LIVE_A];
    find(names, live);
    expect(names).toEqual([`org-${GONE_2}`, `org-${GONE_1}`, 'neo4j']);
    expect(live).toEqual([LIVE_A]);
  });

  it('works on many names (a DBMS with hundreds of leftovers)', async () => {
    const find = await load();
    const gone = Array.from({ length: 300 }, () => randomUUID());
    const liveIds = Array.from({ length: 50 }, () => randomUUID());
    const names = ['neo4j', 'system', ...gone.map((id) => `org-${id}`), ...liveIds.map((id) => `org-${id}`)];
    expect(find(names, liveIds)).toEqual(gone.map((id) => `org-${id}`).sort());
  });
});
