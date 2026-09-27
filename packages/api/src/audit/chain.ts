// The audit hash chain (D56, D73): each entry's hash is SHA-256 over the previous entry's hash
// followed by the canonical JSON of the entry (keys sorted at every level, arrays kept in order,
// no whitespace). The first entry of an org links to GENESIS_HASH.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(entry: object): string {
  return JSON.stringify(canonical(entry));
}

export function hashEntry(prevHash: string, entry: object): string {
  return createHash('sha256')
    .update(prevHash + canonicalJson(entry))
    .digest('hex');
}
