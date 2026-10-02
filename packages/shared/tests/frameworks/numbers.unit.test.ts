// S2-001 criterion 5 (D68, D196, D212 (2)): catalog numbers are FWK or REQ plus 7 digits, counted
// from 0001001 per org (the counter itself is S2-003's). Agrees with S1-001's number rules
// (tests/records/numbers.unit.test.ts): same 7 digits, same 1 to 9,999,999 range, same FIRST_NUMBER,
// and `parseCatalogNumber` returns `{ kind, n }` as `parseNumber` does.
import { describe, expect, it } from 'vitest';
import { loadModule } from '../records/load.js';
import { loadFrameworks } from './load.js';

const CATALOG_KINDS = ['framework', 'requirement'] as const;
const PREFIX = { framework: 'FWK', requirement: 'REQ' } as const;

describe('criterion 5: CATALOG_NUMBER_PREFIX', () => {
  it('is FWK for a framework and REQ for a requirement', async () => {
    const { CATALOG_NUMBER_PREFIX } = await loadFrameworks();
    expect(CATALOG_NUMBER_PREFIX).toEqual(PREFIX);
  });

  it('shares no prefix with the S1 record numbers', async () => {
    const { CATALOG_NUMBER_PREFIX } = await loadFrameworks();
    const records = await loadModule('src/records/index.ts');
    const recordPrefixes = Object.values(records.NUMBER_PREFIX as Record<string, string>);
    for (const prefix of Object.values(CATALOG_NUMBER_PREFIX)) expect(recordPrefixes).not.toContain(prefix);
  });
});

describe('criterion 5: formatCatalogNumber', () => {
  it("formatCatalogNumber('requirement', 1014) is REQ0001014", async () => {
    const { formatCatalogNumber } = await loadFrameworks();
    expect(formatCatalogNumber('requirement', 1014)).toBe('REQ0001014');
  });

  it("formatCatalogNumber('framework', 1014) is FWK0001014", async () => {
    const { formatCatalogNumber } = await loadFrameworks();
    expect(formatCatalogNumber('framework', 1014)).toBe('FWK0001014');
  });

  it.each(CATALOG_KINDS)(
    '%s: the first number, from the records FIRST_NUMBER (1001), is <prefix>0001001',
    async (kind) => {
      const { formatCatalogNumber } = await loadFrameworks();
      const records = await loadModule('src/records/index.ts');
      expect(records.FIRST_NUMBER).toBe(1001);
      expect(formatCatalogNumber(kind, records.FIRST_NUMBER as number)).toBe(`${PREFIX[kind]}0001001`);
    },
  );

  it.each([
    [1, '0000001'],
    [42, '0000042'],
    [1001, '0001001'],
    [123456, '0123456'],
    [9_999_999, '9999999'],
  ])('pads %i to 7 digits', async (n, digits) => {
    const { formatCatalogNumber } = await loadFrameworks();
    expect(formatCatalogNumber('requirement', n)).toBe(`REQ${digits}`);
    expect(formatCatalogNumber('framework', n)).toBe(`FWK${digits}`);
  });

  it.each([0, -1, 10_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses n = %s', async (n) => {
    const { formatCatalogNumber } = await loadFrameworks();
    expect(() => formatCatalogNumber('requirement', n)).toThrow();
    expect(() => formatCatalogNumber('framework', n)).toThrow();
  });

  it.each(['risk', 'control', 'Requirement', 'FWK', '', 'toString'])('refuses an unknown kind %j', async (kind) => {
    const { formatCatalogNumber } = await loadFrameworks();
    expect(() => formatCatalogNumber(kind, 1001)).toThrow();
  });
});

describe('criterion 5: parseCatalogNumber', () => {
  it.each(CATALOG_KINDS.flatMap((kind) => [1, 1001, 1014, 9_999_999].map((n) => [kind, n] as const)))(
    '%s: round-trips %i',
    async (kind, n) => {
      const { formatCatalogNumber, parseCatalogNumber } = await loadFrameworks();
      expect(parseCatalogNumber(formatCatalogNumber(kind, n))).toEqual({ kind, n });
    },
  );

  it('reads REQ0001014 as requirement 1014 and FWK0001001 as framework 1001', async () => {
    const { parseCatalogNumber } = await loadFrameworks();
    expect(parseCatalogNumber('REQ0001014')).toEqual({ kind: 'requirement', n: 1014 });
    expect(parseCatalogNumber('FWK0001001')).toEqual({ kind: 'framework', n: 1001 });
  });

  it.each([
    'RSK0001014',
    'CTL0001001',
    'req0001014',
    'fwk0001001',
    'Req0001014',
    'REQ001014',
    'REQ00010140',
    'REQ0000000',
    'REQ-0001014',
    ' REQ0001014',
    'REQ0001014 ',
    'REQ0001014\n',
    'REQ00O1014',
    'REQ０００１０１４', // full-width digits
    'REQ٠٠٠١٠١٤', // Arabic-Indic digits
    'REQ0001014​', // a trailing zero-width space
    'REQ+001014',
    'REQ 001014',
    'REQ',
    'XYZ0001014',
    '',
    null,
    undefined,
    1014,
    {},
  ])('returns null for %j', async (text) => {
    const { parseCatalogNumber } = await loadFrameworks();
    expect(parseCatalogNumber(text)).toBeNull();
  });
});
