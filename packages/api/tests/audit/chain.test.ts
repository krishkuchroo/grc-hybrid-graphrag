// M0-012 interface: `hashEntry(prevHash, entry)` is SHA-256 over the previous hash plus a
// canonical JSON of the entry with sorted keys (brief, Interfaces; D56, D73). No database.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

type HashEntry = (prevHash: string, entry: object) => string;
let hashEntry: HashEntry;

beforeAll(async () => {
  const mod = (await import('../../src/audit/chain.js')) as unknown as { hashEntry?: HashEntry };
  if (typeof mod.hashEntry !== 'function') throw new Error('src/audit/chain.ts must export hashEntry');
  hashEntry = mod.hashEntry;
});

const PREV = 'a'.repeat(64);

describe('hashEntry', () => {
  it('is SHA-256 hex over the previous hash followed by the entry as JSON with sorted keys', () => {
    const entry = { seq: 3, action: 'risk.updated', orgId: '6f1c2a51-0b7e-4c1d-9a55-2f3e4d5c6b7a', actorId: 'u1' };
    const canonical = JSON.stringify({
      action: 'risk.updated',
      actorId: 'u1',
      orgId: '6f1c2a51-0b7e-4c1d-9a55-2f3e4d5c6b7a',
      seq: 3,
    });
    const expected = createHash('sha256')
      .update(PREV + canonical)
      .digest('hex');
    expect(hashEntry(PREV, entry)).toBe(expected);
  });

  it('returns 64 lowercase hex characters', () => {
    expect(hashEntry(PREV, { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash whatever order the keys were written in, at every level', () => {
    const one = { action: 'x', after: { b: 2, a: { d: 4, c: 3 } }, seq: 1 };
    const two = { seq: 1, after: { a: { c: 3, d: 4 }, b: 2 }, action: 'x' };
    expect(hashEntry(PREV, one)).toBe(hashEntry(PREV, two));
  });

  it('keeps array order (a reordered list is a different entry)', () => {
    expect(hashEntry(PREV, { list: [1, 2] })).not.toBe(hashEntry(PREV, { list: [2, 1] }));
  });

  it('changes when the previous hash changes', () => {
    const entry = { action: 'x', seq: 2 };
    expect(hashEntry(PREV, entry)).not.toBe(hashEntry('b'.repeat(64), entry));
  });

  it('changes when any field of the entry changes, including nested ones', () => {
    const base = { action: 'x', seq: 2, after: { status: 'active' } };
    const h = hashEntry(PREV, base);
    expect(hashEntry(PREV, { ...base, action: 'y' })).not.toBe(h);
    expect(hashEntry(PREV, { ...base, seq: 3 })).not.toBe(h);
    expect(hashEntry(PREV, { ...base, after: { status: 'retired' } })).not.toBe(h);
  });

  it('is deterministic', () => {
    const entry = { action: 'x', meta: { n: 1 } };
    expect(hashEntry(PREV, entry)).toBe(hashEntry(PREV, { ...entry }));
  });
});
