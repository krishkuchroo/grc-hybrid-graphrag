// Requirement codes (D20, D212 (1)): the pattern each framework's codes follow, their group, the
// base control of an 800-53 enhancement, a natural-order sort key, and the stable IDs of catalog
// nodes. Codes are kept exactly as the standard publishes them: never re-cased, re-padded or
// re-written. Errors name no code (D163, D164).
import { createHash } from 'node:crypto';
import { FRAMEWORKS, isFrameworkKey, type FrameworkKey } from './frameworks.js';

export const CODE_PATTERNS: Readonly<Record<FrameworkKey, RegExp>> = Object.freeze({
  nist_800_53: /^[A-Z]{2}-\d{1,2}(\(\d{1,2}\))?$/,
  nist_csf_2: /^(GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d{2}$/,
  iso_27001: /^A\.[5-8]\.\d{1,2}$/,
  soc_2: /^(CC[1-9]|A1|C1|PI1|P[1-8])\.\d{1,2}$/,
});

/** True when `code` is a well-formed requirement code of the framework `key`. */
export function isRequirementCode(key: unknown, code: unknown): boolean {
  return isFrameworkKey(key) && typeof code === 'string' && CODE_PATTERNS[key].test(code);
}

function checked(key: string, code: string): FrameworkKey {
  if (!isFrameworkKey(key) || !isRequirementCode(key, code)) {
    throw new Error('not a requirement code of a known framework');
  }
  return key;
}

/** The group code: the 800-53 family (`AC`), the CSF category (`GV.OC`), the ISO theme (`A.5`) or
 * the SOC 2 series (`CC6`). Throws on a code that isn't the framework's. */
export function groupOf(key: FrameworkKey | string, code: string): string {
  switch (checked(key, code)) {
    case 'nist_800_53':
      return code.slice(0, 2);
    case 'nist_csf_2':
      return code.slice(0, 5);
    case 'iso_27001':
      return code.slice(0, 3);
    case 'soc_2':
      return code.slice(0, code.indexOf('.'));
  }
}

/** The base control of an 800-53 enhancement (`AC-2` for `AC-2(1)`), else `null`. Throws on a
 * code that isn't the framework's. */
export function parentCodeOf(key: FrameworkKey | string, code: string): string | null {
  const framework = checked(key, code);
  const open = code.indexOf('(');
  return framework === 'nist_800_53' && open > 0 ? code.slice(0, open) : null;
}

/** Groups the framework doesn't list sort after the ones it does. */
const UNKNOWN_GROUP_RANK = 99;

/** A string whose plain (code unit) order is the natural order of the framework's codes: groups in
 * the order the framework publishes them, then numbers by value, a base control before its
 * enhancements (`AC-2`, `AC-2(1)`, `AC-2(10)`, `AC-3`, `AC-10`). Throws on a code that isn't the
 * framework's. */
export function sortKeyOf(key: FrameworkKey | string, code: string): string {
  const framework = checked(key, code);
  const rank = Object.keys(FRAMEWORKS[framework].groupNames).indexOf(groupOf(framework, code));
  const prefix = String(rank < 0 ? UNKNOWN_GROUP_RANK : rank).padStart(2, '0');
  return `${prefix}:${code.replace(/\d+/g, (digits) => digits.padStart(3, '0'))}`;
}

/** The fixed namespace of the catalog nodes' name-based IDs. Never change it: the IDs are the same
 * in every org's graph. */
export const CATALOG_NAMESPACE = 'd0844755-5c9f-4603-a5c6-9a94211bcc69';

/** RFC 9562 UUID v5 (SHA-1, name-based) of `name` in CATALOG_NAMESPACE, as `orgIdForSlug` makes org IDs. */
function catalogUuid(name: string): string {
  const ns = Buffer.from(CATALOG_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The stable ID of a Framework node: the UUID v5 of `framework:<key>`. */
export function frameworkIdFor(key: FrameworkKey | string): string {
  if (!isFrameworkKey(key)) throw new Error('unknown framework key');
  return catalogUuid(`framework:${key}`);
}

/** The stable ID of a Requirement node: the UUID v5 of `requirement:<key>:<code>`. */
export function requirementIdFor(key: FrameworkKey | string, code: string): string {
  return catalogUuid(`requirement:${checked(key, code)}:${code}`);
}
