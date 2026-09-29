// S3-016 criteria 2–5 at the `stress` size (D48: 20 orgs × 2,000 assets, 300 risks, 400 controls,
// 40 policies, 1,000 incidents).
// - Criterion 4: `stress` builds in under 30 s and in under 1 GB of memory, in this one process.
// - Criterion 2: the counts match exactly in every org.
// - Criterion 3 (and 2's validity): the shape rules hold on a sample of orgs.
// - Criterion 5: all 20 orgs have different names and estates.
// The world is built once, by whichever test asks first; the time and the peak memory are those of
// that one build, so the result doesn't depend on the order the tests run in.
import { describe, expect, it } from 'vitest';
import { countProblems, cycleProblems, linkProblems, recordProblems, sameOrgProblems, shapeProblems } from './check.js';
import { loadWorld, type AnswerKey } from './load.js';

const SEED = 20260929;
const THIRTY_SECONDS = 30_000;
const ONE_GB = 1024 * 1024 * 1024;
// Long enough that a slow build fails on the 30 s check below, not on Vitest's timeout.
const TEST_TIMEOUT = 180_000;

interface StressBuild {
  key: AnswerKey;
  ms: number;
  peakRssBytes: number;
}

let built: Promise<StressBuild> | undefined;

function stress(): Promise<StressBuild> {
  built ??= (async () => {
    const { buildWorld, SIZES } = await loadWorld();
    const start = performance.now();
    const key = buildWorld({ seed: SEED, size: SIZES.stress });
    const ms = performance.now() - start;
    // maxRSS is the process's peak resident memory so far, in kilobytes.
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;
    return { key, ms, peakRssBytes };
  })();
  return built;
}

/** The sample of orgs whose every record and link is checked: the first, a middle one and the last. */
function sample(key: AnswerKey) {
  const orgs = key.orgs;
  return [orgs[0], orgs[Math.floor(orgs.length / 2)], orgs[orgs.length - 1]].filter((org) => org !== undefined);
}

describe('criterion 4: stress builds within its budget', () => {
  it(
    'builds in under 30 s',
    async () => {
      const { ms } = await stress();
      expect(ms, `stress took ${Math.round(ms)} ms`).toBeLessThan(THIRTY_SECONDS);
    },
    TEST_TIMEOUT,
  );

  it(
    'builds in under 1 GB of memory in this one process',
    async () => {
      const { peakRssBytes } = await stress();
      expect(peakRssBytes, `peak memory ${Math.round(peakRssBytes / 1024 / 1024)} MB`).toBeLessThan(ONE_GB);
    },
    TEST_TIMEOUT,
  );
});

describe('stress: counts, validity, shape and different orgs', () => {
  it(
    'has 20 orgs with exactly the size’s counts in each',
    async () => {
      const { key } = await stress();
      expect(key.orgs).toHaveLength(20);
      expect(key.orgs.flatMap((org) => countProblems(org, key.size))).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'a sample of orgs has valid records, allowed links and no HOSTS/RUNS cycles',
    async () => {
      const { key } = await stress();
      const orgs = sample(key);
      expect(orgs).toHaveLength(3);
      expect(orgs.flatMap((org) => [...recordProblems(org), ...linkProblems(org), ...cycleProblems(org)])).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'a sample of orgs follows the shape rules',
    async () => {
      const { key } = await stress();
      const orgs = sample(key);
      expect(orgs).toHaveLength(3);
      expect(orgs.flatMap(shapeProblems)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'its 20 orgs have different names and estates',
    async () => {
      const { key } = await stress();
      expect(sameOrgProblems(key.orgs)).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
