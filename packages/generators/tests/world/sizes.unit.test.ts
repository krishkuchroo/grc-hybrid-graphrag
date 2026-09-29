// S3-016: the size dial (D18, D48) and the generator version (D45.8).
// SIZES: `tiny` and `stress` as the brief gives them (stress is D48's 20 orgs × 2,000 assets, 300 risks,
// 400 controls, 40 policies, 1,000 incidents); `accuracy` is D48's 2 orgs. parseSize reads a size
// name or `custom:orgs=…,assets=…`, and refuses anything else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATORS_DIR, SIZE_FIELDS, loadGenerators, loadWorld } from './load.js';

describe('SIZES', () => {
  it('tiny is 1 org of 30 assets, 10 risks, 15 controls, 3 policies and 10 incidents', async () => {
    const { SIZES } = await loadWorld();
    expect(SIZES.tiny).toEqual({ orgs: 1, assets: 30, risks: 10, controls: 15, policies: 3, incidents: 10 });
  });

  it("stress is D48's 20 orgs of 2,000 assets, 300 risks, 400 controls, 40 policies and 1,000 incidents", async () => {
    const { SIZES } = await loadWorld();
    expect(SIZES.stress).toEqual({ orgs: 20, assets: 2000, risks: 300, controls: 400, policies: 40, incidents: 1000 });
  });

  it("accuracy is D48's 2 orgs, with a positive whole count of every record type", async () => {
    const { SIZES } = await loadWorld();
    expect(SIZES.accuracy.orgs).toBe(2);
    for (const field of SIZE_FIELDS) {
      expect(Number.isInteger(SIZES.accuracy[field]) && SIZES.accuracy[field] > 0, `accuracy.${field}`).toBe(true);
    }
  });
});

describe('parseSize', () => {
  it.each(['tiny', 'accuracy', 'stress'] as const)('reads the name %s as that size', async (name) => {
    const { SIZES, parseSize } = await loadWorld();
    expect(parseSize(name)).toEqual(SIZES[name]);
  });

  it('reads a custom size', async () => {
    const { parseSize } = await loadWorld();
    expect(parseSize('custom:orgs=3,assets=12,risks=4,controls=5,policies=2,incidents=3')).toEqual({
      orgs: 3,
      assets: 12,
      risks: 4,
      controls: 5,
      policies: 2,
      incidents: 3,
    });
  });

  it.each([
    'huge',
    '',
    'custom:orgs=abc,assets=12,risks=4,controls=5,policies=2,incidents=3',
    'custom:orgs=2.5,assets=12,risks=4,controls=5,policies=2,incidents=3',
    'custom:orgs=-1,assets=12,risks=4,controls=5,policies=2,incidents=3',
    'custom:orgs=2,assets=12,risks=4,controls=5,policies=2,incidents=3,widgets=9',
  ])('refuses %j', async (text) => {
    const { parseSize } = await loadWorld();
    expect(() => parseSize(text)).toThrow();
  });
});

describe('GENERATOR_VERSION (D45.8)', () => {
  it('is a non-empty string', async () => {
    const { GENERATOR_VERSION } = await loadWorld();
    expect(typeof GENERATOR_VERSION).toBe('string');
    expect(GENERATOR_VERSION.trim().length).toBeGreaterThan(0);
  });
});

describe('the package entry point', () => {
  it('src/index.ts exports SIZES, parseSize, GENERATOR_VERSION and buildWorld from the world', async () => {
    const world = await loadWorld();
    const entry = await loadGenerators();
    expect(entry.SIZES).toBe(world.SIZES);
    expect(entry.parseSize).toBe(world.parseSize);
    expect(entry.GENERATOR_VERSION).toBe(world.GENERATOR_VERSION);
    expect(entry.buildWorld).toBe(world.buildWorld);
  });
});

describe('dependencies (D33, D45.8: fixed seeds only repeat with a fixed faker)', () => {
  const pkg = JSON.parse(readFileSync(join(GENERATORS_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  it('@faker-js/faker is a dependency pinned to an exact version', () => {
    expect(pkg.dependencies?.['@faker-js/faker'] ?? '(missing)', 'dependencies["@faker-js/faker"]').toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it('@grc/shared is a workspace dependency', () => {
    expect(pkg.dependencies?.['@grc/shared'] ?? '(missing)', 'dependencies["@grc/shared"]').toMatch(/^workspace:/);
  });
});
