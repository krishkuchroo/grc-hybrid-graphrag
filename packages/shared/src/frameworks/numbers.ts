// Catalog numbers (D68, D212 (2)): `FWK` or `REQ` plus 7 digits, counted per org from the records'
// FIRST_NUMBER (1001), as D196, so the first ones are `FWK0001001` and `REQ0001001`.

export const CATALOG_KINDS = ['framework', 'requirement'] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];

export function isCatalogKind(value: unknown): value is CatalogKind {
  return typeof value === 'string' && (CATALOG_KINDS as readonly string[]).includes(value);
}

export const CATALOG_NUMBER_PREFIX = Object.freeze({
  framework: 'FWK',
  requirement: 'REQ',
} as const satisfies Record<CatalogKind, string>);

const DIGITS = 7;
const MAX_NUMBER = 9_999_999;
const CATALOG_NUMBER_PATTERN = /^(FWK|REQ)(\d{7})$/;

export function formatCatalogNumber(kind: CatalogKind | string, n: number): string {
  if (!isCatalogKind(kind)) throw new Error('unknown catalog kind');
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new Error('catalog number out of range');
  return `${CATALOG_NUMBER_PREFIX[kind]}${String(n).padStart(DIGITS, '0')}`;
}

/** `{ kind, n }` for a catalog number, `null` for anything else (record numbers included). */
export function parseCatalogNumber(text: unknown): { kind: CatalogKind; n: number } | null {
  const match = typeof text === 'string' ? CATALOG_NUMBER_PATTERN.exec(text) : null;
  if (!match) return null;
  const kind = CATALOG_KINDS.find((k) => CATALOG_NUMBER_PREFIX[k] === match[1]);
  const n = Number(match[2]);
  if (kind === undefined || n < 1) return null;
  return { kind, n };
}
