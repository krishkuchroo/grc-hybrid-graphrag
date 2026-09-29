// S3-016 criterion 3: the world's shape holds for every org of `tiny` and `accuracy`.
// - HOSTS and RUNS form a layered estate: network devices and cloud services host servers, servers
//   host databases and run applications.
// - Every risk is exposed through at least one asset and mitigated by 1 to 3 controls.
// - Every control is governed by one policy.
// - Incidents impact 1 to 3 assets and expose 0 to 2 risks.
// The sample of `stress` is in stress.unit.test.ts.
import { describe, expect, it } from 'vitest';
import { estateLinks, shapeProblems } from './check.js';
import { loadWorld } from './load.js';

describe.each([
  { name: 'tiny', seeds: [1, 2, 3] },
  { name: 'accuracy', seeds: [1, 2] },
] as const)('criterion 3: the shape of every $name org', ({ name, seeds }) => {
  it.each(seeds)('holds for seed %i', async (seed) => {
    const { buildWorld, SIZES } = await loadWorld();
    const key = buildWorld({ seed, size: SIZES[name] });
    expect(key.orgs.length).toBeGreaterThan(0);
    expect(key.orgs.flatMap(shapeProblems)).toEqual([]);
  });

  it('has a layered estate with HOSTS and RUNS links in every org', async () => {
    const { buildWorld, SIZES } = await loadWorld();
    const key = buildWorld({ seed: seeds[0], size: SIZES[name] });
    for (const org of key.orgs) {
      const types = new Set(estateLinks(org).map((link) => link.type));
      expect([...types].sort(), `${org.key} HOSTS/RUNS links`).toEqual(['HOSTS', 'RUNS']);
    }
  });
});
