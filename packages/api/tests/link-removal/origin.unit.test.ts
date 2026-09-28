// S1-011 criterion 2 (D207): which link origins POST /api/v1/links/remove may remove. One pure rule
// in @grc/shared (packages/shared/src/records/link-rules.ts), used by the API and the web (S1-012):
// `isRemovableLinkOrigin(origin)` is true for exactly `manual` and `import`, and
// `REMOVABLE_LINK_ORIGINS` is `['manual', 'import']`. No database, server or .env.
import * as shared from '@grc/shared';
import { describe, expect, it } from 'vitest';

type Rule = (origin: unknown) => boolean;

function rule(): Rule {
  const fn = (shared as Record<string, unknown>)['isRemovableLinkOrigin'];
  expect(typeof fn, '@grc/shared exports isRemovableLinkOrigin (link-rules.ts)').toBe('function');
  return fn as Rule;
}

describe('criterion 2: isRemovableLinkOrigin (D207)', () => {
  it.each(['manual', 'import'])('%s: removable', (origin) => {
    expect(rule()(origin)).toBe(true);
  });

  it.each([
    ['ai', 'ai'],
    ['an empty string', ''],
    ['an unknown value', 'robot'],
    ['a different case', 'Manual'],
    ['padded', ' manual '],
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
  ])('%s: not removable', (_what, origin) => {
    expect(rule()(origin)).toBe(false);
  });
});

describe('criterion 2: REMOVABLE_LINK_ORIGINS (D207)', () => {
  it('is exactly manual and import, in that order', () => {
    const list = (shared as Record<string, unknown>)['REMOVABLE_LINK_ORIGINS'];
    expect(list, '@grc/shared exports REMOVABLE_LINK_ORIGINS').toEqual(['manual', 'import']);
  });

  it('agrees with isRemovableLinkOrigin', () => {
    const list = ((shared as Record<string, unknown>)['REMOVABLE_LINK_ORIGINS'] ?? []) as readonly string[];
    const fn = rule();
    for (const origin of ['manual', 'import', 'ai']) expect(fn(origin)).toBe(list.includes(origin));
  });
});
