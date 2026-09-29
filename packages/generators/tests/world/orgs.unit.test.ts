// S3-016 criterion 5 (D18: a size dial for the number of orgs): the orgs of one world have different
// names and different estates (asset names, and asset types with their HOSTS/RUNS links).
// The 20 orgs of `stress` are checked in stress.unit.test.ts.
import { describe, expect, it } from 'vitest';
import { sameOrgProblems } from './check.js';
import { loadWorld, type SizeSpec } from './load.js';

const FIVE_ORGS: SizeSpec = { orgs: 5, assets: 20, risks: 5, controls: 6, policies: 2, incidents: 4 };

describe('criterion 5: different orgs in one world', () => {
  it.each([1, 2, 3])('the 2 accuracy orgs differ for seed %i', async (seed) => {
    const { buildWorld, SIZES } = await loadWorld();
    const key = buildWorld({ seed, size: SIZES.accuracy });
    expect(key.orgs).toHaveLength(2);
    expect(sameOrgProblems(key.orgs)).toEqual([]);
  });

  it('the orgs of a 5-org custom world all differ', async () => {
    const { buildWorld } = await loadWorld();
    const key = buildWorld({ seed: 31, size: FIVE_ORGS });
    expect(key.orgs).toHaveLength(5);
    expect(sameOrgProblems(key.orgs)).toEqual([]);
  });
});
