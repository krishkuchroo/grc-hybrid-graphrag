// S1-001 criterion 5 (the spec's ontology, section 2): the allowed links and their direction.
// SATISFIES, MAPS_TO, SUPPORTS and CONCERNS come with S2 and S3 (D202), so they are not allowed here.
import { describe, expect, it } from 'vitest';
import { KINDS, loadRecords } from './load.js';

const ALLOWED = [
  { type: 'HOSTS', from: 'asset', to: 'asset' },
  { type: 'RUNS', from: 'asset', to: 'asset' },
  { type: 'EXPOSED_TO', from: 'asset', to: 'risk' },
  { type: 'MITIGATED_BY', from: 'risk', to: 'control' },
  { type: 'GOVERNED_BY', from: 'control', to: 'policy' },
  { type: 'IMPACTS', from: 'incident', to: 'asset' },
  { type: 'EXPOSES', from: 'incident', to: 'risk' },
] as const;

const TYPES = [...new Set(ALLOWED.map((row) => row.type))];

function allowed(type: string, from: string, to: string): boolean {
  return ALLOWED.some((row) => row.type === type && row.from === from && row.to === to);
}

const EVERY_TRIPLE = TYPES.flatMap((type) =>
  KINDS.flatMap((from) => KINDS.map((to) => [type, from, to, allowed(type, from, to)] as const)),
);

const byRow = (a: { type: string; from: string; to: string }, b: { type: string; from: string; to: string }) =>
  `${a.type}:${a.from}:${a.to}`.localeCompare(`${b.type}:${b.from}:${b.to}`);

describe('criterion 5: LINK_TYPES', () => {
  it("is exactly the spec's links, each with its direction", async () => {
    const { LINK_TYPES } = await loadRecords();
    const rows = LINK_TYPES.map(({ type, from, to }) => ({ type, from, to }));
    expect(rows.sort(byRow)).toEqual([...ALLOWED].sort(byRow));
  });
});

describe('criterion 5: isAllowedLink', () => {
  it(`checks every link type x from x to (${EVERY_TRIPLE.length} triples)`, () => {
    // Seven link types (HOSTS and RUNS are the spec's HOSTS|RUNS), five kinds at each end.
    expect(EVERY_TRIPLE).toHaveLength(7 * 5 * 5);
  });

  it.each(EVERY_TRIPLE)('%s from %s to %s -> %s', async (type, from, to, expected) => {
    const { isAllowedLink } = await loadRecords();
    expect(isAllowedLink(type, from, to)).toBe(expected);
  });

  it.each(ALLOWED.filter((row) => row.from !== row.to))(
    'refuses $type in the reverse direction ($to to $from)',
    async ({ type, from, to }) => {
      const { isAllowedLink } = await loadRecords();
      expect(isAllowedLink(type, to, from)).toBe(false);
    },
  );

  it.each([
    ['an unknown type', 'OWNS', 'asset', 'asset'],
    ['a lowercase type', 'hosts', 'asset', 'asset'],
    ['a later slice type (S2)', 'SATISFIES', 'control', 'requirement'],
    ['a later slice type (S3)', 'SUPPORTS', 'evidence', 'control'],
    ['an empty type', '', 'asset', 'risk'],
    ['an unknown from kind', 'EXPOSED_TO', 'server', 'risk'],
    ['an unknown to kind', 'EXPOSED_TO', 'asset', 'threat'],
    ['a node label instead of a kind', 'EXPOSED_TO', 'Asset', 'Risk'],
    ['a plural path instead of a kind', 'MITIGATED_BY', 'risks', 'controls'],
    ['an empty kind', 'HOSTS', '', 'asset'],
  ])('refuses %s', async (_what, type, from, to) => {
    const { isAllowedLink } = await loadRecords();
    expect(isAllowedLink(type, from, to)).toBe(false);
  });
});

describe('criterion 5: linkTypesBetween', () => {
  it.each(KINDS.flatMap((from) => KINDS.map((to) => [from, to] as const)))(
    '%s to %s lists exactly the allowed types',
    async (from, to) => {
      const { linkTypesBetween } = await loadRecords();
      const expected = ALLOWED.filter((row) => row.from === from && row.to === to)
        .map((row) => row.type)
        .sort();
      expect([...linkTypesBetween(from, to)].sort()).toEqual(expected);
    },
  );

  it('asset to asset is HOSTS and RUNS', async () => {
    const { linkTypesBetween } = await loadRecords();
    expect([...linkTypesBetween('asset', 'asset')].sort()).toEqual(['HOSTS', 'RUNS']);
  });

  it('is empty for unknown kinds', async () => {
    const { linkTypesBetween } = await loadRecords();
    expect([...linkTypesBetween('framework', 'asset')]).toEqual([]);
    expect([...linkTypesBetween('asset', 'evidence')]).toEqual([]);
  });
});
