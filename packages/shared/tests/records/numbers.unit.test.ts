// S1-001 criterion 3 (D68, D196): record numbers are a three-letter prefix per kind plus 7 digits,
// counted from 1001 per org and per type (the counter itself is S1-003's).
import { describe, expect, it } from 'vitest';
import { KINDS, loadRecords, type Kind } from './load.js';

const PREFIX: Record<Kind, string> = { risk: 'RSK', asset: 'AST', control: 'CTL', policy: 'POL', incident: 'INC' };

describe('criterion 3: NUMBER_PREFIX and FIRST_NUMBER', () => {
  it('NUMBER_PREFIX is the D196 table', async () => {
    const { NUMBER_PREFIX } = await loadRecords();
    expect(NUMBER_PREFIX).toEqual(PREFIX);
  });

  it('FIRST_NUMBER is 1001', async () => {
    const { FIRST_NUMBER } = await loadRecords();
    expect(FIRST_NUMBER).toBe(1001);
  });
});

describe('criterion 3: formatNumber', () => {
  it("formats D68's example: formatNumber('risk', 1014) is RSK0001014", async () => {
    const { formatNumber } = await loadRecords();
    expect(formatNumber('risk', 1014)).toBe('RSK0001014');
  });

  it.each(KINDS)('%s: the first number has its prefix and 7 digits', async (kind) => {
    const { formatNumber } = await loadRecords();
    expect(formatNumber(kind, 1001)).toBe(`${PREFIX[kind]}0001001`);
  });

  it.each([
    [1, '0000001'],
    [42, '0000042'],
    [1001, '0001001'],
    [123456, '0123456'],
    [9_999_999, '9999999'],
  ])('pads %i to 7 digits', async (n, digits) => {
    const { formatNumber } = await loadRecords();
    expect(formatNumber('asset', n)).toBe(`AST${digits}`);
  });

  it.each([0, -1, 10_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses n = %s', async (n) => {
    const { formatNumber } = await loadRecords();
    expect(() => formatNumber('risk', n)).toThrow();
  });

  it('refuses an unknown kind', async () => {
    const { formatNumber } = await loadRecords();
    expect(() => formatNumber('framework', 1001)).toThrow();
  });
});

describe('criterion 3: parseNumber', () => {
  it.each(KINDS.flatMap((kind) => [1, 1001, 1014, 9_999_999].map((n) => [kind, n] as const)))(
    '%s: round-trips %i',
    async (kind, n) => {
      const { formatNumber, parseNumber } = await loadRecords();
      expect(parseNumber(formatNumber(kind, n))).toEqual({ kind, n });
    },
  );

  it.each([
    ['a wrong prefix', 'XYZ0001001'],
    ['a prefix from another system', 'REQ0001001'],
    ['a lowercase prefix', 'rsk0001001'],
    ['a mixed-case prefix', 'Rsk0001001'],
    ['6 digits', 'RSK001001'],
    ['8 digits', 'RSK00010011'],
    ['no digits', 'RSK'],
    ['a letter among the digits', 'RSK000100a'],
    ['a space before', ' RSK0001001'],
    ['a space after', 'RSK0001001 '],
    ['a separator', 'RSK-0001001'],
    ['zero', 'RSK0000000'],
    ['an empty string', ''],
  ])('returns null for %s (%j)', async (_what, text) => {
    const { parseNumber } = await loadRecords();
    expect(parseNumber(text)).toBeNull();
  });
});
