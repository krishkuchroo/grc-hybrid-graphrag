// M0-006 criterion 3: an object put for org A can't be read through org B's calls (D53, D59 every org pair).
// Three orgs give every ordered pair (A→B, A→C, B→A, …). Live against 127.0.0.1:8333 (D132, D137).
import { describe, expect, it } from 'vitest';
import { liveStore, newOrgId } from './helpers.js';

describe('storage: org wall (criterion 3)', () => {
  it('no org reads, or sees, another org’s object under the same key', async () => {
    const store = await liveStore();
    const orgs = [newOrgId(), newOrgId(), newOrgId()];
    const key = 'shared/name/report.pdf';
    const bodyFor = (org: string) => Buffer.from(`owned by ${org}`);

    // Only the first two orgs hold the key; the third has an empty bucket.
    for (const org of orgs) await store.ensureBucket(org);
    await store.put(orgs[0]!, key, bodyFor(orgs[0]!), 'application/pdf');
    await store.put(orgs[1]!, `only-b/${key}`, bodyFor(orgs[1]!), 'application/pdf');

    const held: Array<[owner: string, key: string]> = [
      [orgs[0]!, key],
      [orgs[1]!, `only-b/${key}`],
    ];
    for (const [owner, k] of held) {
      for (const other of orgs.filter((o) => o !== owner)) {
        expect(await store.exists(other, k), `${other} sees ${owner}'s ${k}`).toBe(false);
        await expect(store.get(other, k), `${other} read ${owner}'s ${k}`).rejects.toThrow();
      }
    }

    // The owners still read their own bytes.
    expect((await store.get(orgs[0]!, key)).equals(bodyFor(orgs[0]!))).toBe(true);
    expect((await store.get(orgs[1]!, `only-b/${key}`)).equals(bodyFor(orgs[1]!))).toBe(true);
  });

  it('the same key in two orgs holds two separate objects', async () => {
    const store = await liveStore();
    const a = newOrgId();
    const b = newOrgId();
    await store.ensureBucket(a);
    await store.ensureBucket(b);
    await store.put(a, 'policy.docx', Buffer.from('A version'), 'application/octet-stream');
    await store.put(b, 'policy.docx', Buffer.from('B version'), 'application/octet-stream');
    expect((await store.get(a, 'policy.docx')).toString()).toBe('A version');
    expect((await store.get(b, 'policy.docx')).toString()).toBe('B version');
  });

  it('a key that walks out of the bucket does not reach another org', async () => {
    const store = await liveStore();
    const a = newOrgId();
    const b = newOrgId();
    await store.ensureBucket(a);
    await store.ensureBucket(b);
    await store.put(a, 'secret.txt', Buffer.from('A only'), 'text/plain');
    const escape = `../grc-org-${a}/secret.txt`;
    const read = await store.get(b, escape).then(
      (buf) => buf.toString(),
      () => undefined,
    );
    expect(read).not.toBe('A only');
    const seen = await store.exists(b, escape).catch(() => false);
    expect(seen).toBe(false);
  });
});
