// S3-016 criterion 1 (D33, D45.8): the same seed and size give byte-identical JSON; two seeds differ.
// The answer key depends on nothing but its inputs: not the clock, not Math.random, and not what
// was built before it in the same process.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorld, type SizeSpec } from './load.js';

const SMALL: SizeSpec = { orgs: 3, assets: 12, risks: 4, controls: 5, policies: 2, incidents: 3 };

async function hashOf(seed: number, size: SizeSpec): Promise<string> {
  const { buildWorld } = await loadWorld();
  return createHash('sha256')
    .update(JSON.stringify(buildWorld({ seed, size })))
    .digest('hex');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('criterion 1: repeatable answer keys', () => {
  it('the same seed and tiny size give byte-identical JSON', async () => {
    const { SIZES } = await loadWorld();
    expect(await hashOf(42, SIZES.tiny)).toBe(await hashOf(42, SIZES.tiny));
  });

  it('the same seed and accuracy size give byte-identical JSON', async () => {
    const { SIZES } = await loadWorld();
    expect(await hashOf(7, SIZES.accuracy)).toBe(await hashOf(7, SIZES.accuracy));
  });

  it('the same seed and a custom size give byte-identical JSON', async () => {
    expect(await hashOf(1001, SMALL)).toBe(await hashOf(1001, SMALL));
  });

  it('two seeds give different answer keys', async () => {
    const { SIZES } = await loadWorld();
    expect(await hashOf(1, SIZES.tiny)).not.toBe(await hashOf(2, SIZES.tiny));
    expect(await hashOf(1, SMALL)).not.toBe(await hashOf(2, SMALL));
  });

  it('a build is not changed by the builds before it in the same process', async () => {
    const first = await hashOf(1, SMALL);
    await hashOf(2, SMALL);
    await hashOf(3, SMALL);
    expect(await hashOf(1, SMALL)).toBe(first);
  });

  it('a build does not depend on the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-15T09:30:00Z'));
    const early = await hashOf(5, SMALL);
    vi.setSystemTime(new Date('2031-11-02T23:59:59Z'));
    const late = await hashOf(5, SMALL);
    expect(late).toBe(early);
  });

  it('a build does not depend on Math.random', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const low = await hashOf(9, SMALL);
    random.mockReturnValue(0.9);
    const high = await hashOf(9, SMALL);
    expect(high).toBe(low);
  });

  it('the answer key records the generator version, the seed and the size', async () => {
    const { buildWorld, GENERATOR_VERSION } = await loadWorld();
    const key = buildWorld({ seed: 77, size: SMALL });
    expect(key.generatorVersion).toBe(GENERATOR_VERSION);
    expect(key.seed).toBe(77);
    expect(key.size).toEqual(SMALL);
  });

  it('the answer key is plain JSON: parsing its JSON gives it back unchanged', async () => {
    const { buildWorld } = await loadWorld();
    const key = buildWorld({ seed: 77, size: SMALL });
    expect(JSON.parse(JSON.stringify(key))).toStrictEqual(key);
  });
});
