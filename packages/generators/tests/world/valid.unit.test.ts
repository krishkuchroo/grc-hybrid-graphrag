// S3-016 criterion 2 (D67, D196, D197, the spec's ontology): every record passes S1's createSchemas for
// its kind (its stable key aside); every link passes isAllowedLink between records of the same org;
// HOSTS and RUNS have no cycles; the counts match the size exactly.
// Agreement (D174): S1-001's schemas.unit.test.ts and links.unit.test.ts in packages/shared/tests/records.
import { describe, expect, it } from 'vitest';
import { countProblems, cycleProblems, linkProblems, recordProblems } from './check.js';
import { loadWorld, type SizeSpec } from './load.js';

const CUSTOM: SizeSpec = { orgs: 3, assets: 12, risks: 4, controls: 5, policies: 2, incidents: 3 };

const CASES = [
  { name: 'tiny', seed: 11 },
  { name: 'accuracy', seed: 12 },
  { name: 'custom', seed: 13 },
] as const;

async function build(name: (typeof CASES)[number]['name'], seed: number) {
  const { buildWorld, SIZES } = await loadWorld();
  const size = name === 'custom' ? CUSTOM : SIZES[name];
  return { size, key: buildWorld({ seed, size }) };
}

describe.each(CASES)('criterion 2: a valid $name world', ({ name, seed }) => {
  it('has exactly the size’s number of orgs', async () => {
    const { size, key } = await build(name, seed);
    expect(key.orgs).toHaveLength(size.orgs);
  });

  it('has exactly the size’s number of each record type in every org', async () => {
    const { size, key } = await build(name, seed);
    expect(key.orgs.flatMap((org) => countProblems(org, size))).toEqual([]);
  });

  it('every org has a key and a name', async () => {
    const { key } = await build(name, seed);
    for (const org of key.orgs) {
      expect(typeof org.key === 'string' && org.key.length > 0, 'org key').toBe(true);
      expect(typeof org.name === 'string' && org.name.trim().length > 0, `${org.key} name`).toBe(true);
    }
  });

  it('every record has a unique key and name and passes S1’s createSchemas for its kind', async () => {
    const { key } = await build(name, seed);
    expect(key.orgs.flatMap(recordProblems)).toEqual([]);
  });

  it('every link joins two records of its org and passes isAllowedLink', async () => {
    const { key } = await build(name, seed);
    for (const org of key.orgs) expect(org.links.length, `${org.key} has no links`).toBeGreaterThan(0);
    expect(key.orgs.flatMap(linkProblems)).toEqual([]);
  });

  it('HOSTS and RUNS have no cycles', async () => {
    const { key } = await build(name, seed);
    expect(key.orgs.flatMap(cycleProblems)).toEqual([]);
  });
});
