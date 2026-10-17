// The size and org slugs a generated question set names (S8-003; D18, D42): the same names
// `pnpm gen:data` gives its folder and its orgs (packages/infra/scripts/gen-data.ts).
// - The folder is `data/generated/<seed>-<size folder>`, where the size folder is the `--size` text
//   lowercased with every run of other characters made one `-` (`custom:orgs=1,assets=30,…` gives
//   `custom-orgs-1-assets-30-…`).
// - Full-pipeline orgs are `gen-<seed>-<n>`, fast-loaded ones `fast-<seed>-<size folder>-<n>`, with
//   `n` counted from 1 in the answer key's order.
// Pure: no I/O.
import { SIZES, SIZE_FIELDS, type SizeName, type SizeSpec } from '@grc/generators';

const SIZE_NAMES = Object.keys(SIZES) as SizeName[];

/** The folder name part for a `--size` text, exactly as `gen:data` makes it. */
export function sizeFolderName(sizeText: string): string {
  return sizeText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sameSize(a: SizeSpec, b: SizeSpec): boolean {
  return SIZE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * The size folder for an answer key's size: the named size it equals (`tiny`, `accuracy`, `stress`),
 * else the custom size with every field in `SIZE_FIELDS` order (`custom-orgs-1-assets-30-…`).
 */
export function sizeFolderOf(size: SizeSpec): string {
  const named = SIZE_NAMES.find((name) => sameSize(SIZES[name], size));
  if (named) return named;
  return sizeFolderName(`custom:${SIZE_FIELDS.map((field) => `${field}=${size[field]}`).join(',')}`);
}

/**
 * Whether a size folder (as `gen:data` names it) describes the size: a named size equal to it, or a
 * custom size whose fields, in any order and each once, hold the same numbers.
 */
export function sizeFolderDescribes(folder: string, size: SizeSpec): boolean {
  if ((SIZE_NAMES as string[]).includes(folder)) return sameSize(SIZES[folder as SizeName], size);
  const parts = folder.split('-');
  if (parts[0] !== 'custom' || parts.length !== 1 + 2 * SIZE_FIELDS.length) return false;
  const seen = new Set<string>();
  for (let i = 1; i < parts.length; i += 2) {
    const field = parts[i]!;
    const value = parts[i + 1]!;
    if (!(SIZE_FIELDS as readonly string[]).includes(field) || seen.has(field) || !/^\d+$/.test(value)) return false;
    seen.add(field);
    if (Number(value) !== size[field as (typeof SIZE_FIELDS)[number]]) return false;
  }
  return true;
}

/** The full-pipeline org slug of the answer key's org at `index` (from 0). */
export function fullPipelineOrgSlug(seed: number, index: number): string {
  return `gen-${seed}-${index + 1}`;
}

/** The fast-loaded org slug of the answer key's org at `index` (from 0). */
export function fastLoadOrgSlug(seed: number, sizeFolder: string, index: number): string {
  return `fast-${seed}-${sizeFolder}-${index + 1}`;
}
