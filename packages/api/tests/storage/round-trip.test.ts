// M0-006 criterion 2: `put` / `get` / `exists` round-trip bytes exactly.
// Live against SeaweedFS at 127.0.0.1:8333 through the dev switch (D132, D137); see helpers.ts.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveStore, newOrgId } from './helpers.js';

describe('storage: put / get / exists (criterion 2)', () => {
  it('returns every byte value 0-255 unchanged', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    const body = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    await store.put(org, 'bytes/all-values.bin', body, 'application/octet-stream');
    const back = await store.get(org, 'bytes/all-values.bin');
    expect(Buffer.isBuffer(back)).toBe(true);
    expect(back.length).toBe(body.length);
    expect(back.equals(body)).toBe(true);
  });

  it('returns a 3 MB random file unchanged', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    const body = randomBytes(3 * 1024 * 1024);
    await store.put(org, 'uploads/2026/09/large.pdf', body, 'application/pdf');
    const back = await store.get(org, 'uploads/2026/09/large.pdf');
    expect(back.length).toBe(body.length);
    expect(back.equals(body)).toBe(true);
  });

  it('returns UTF-8 text unchanged', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    const body = Buffer.from('Risk RSK0001014: café, 東京, emoji \u{1F512}\n', 'utf8');
    await store.put(org, 'text/note.txt', body, 'text/plain; charset=utf-8');
    expect((await store.get(org, 'text/note.txt')).equals(body)).toBe(true);
  });

  it('a second put to the same key replaces the bytes', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    await store.put(org, 'same.json', Buffer.from('{"v":1}'), 'application/json');
    await store.put(org, 'same.json', Buffer.from('{"v":2}'), 'application/json');
    expect((await store.get(org, 'same.json')).toString('utf8')).toBe('{"v":2}');
  });

  it('exists is false before put and true after', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    expect(await store.exists(org, 'later.csv')).toBe(false);
    await store.put(org, 'later.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
    expect(await store.exists(org, 'later.csv')).toBe(true);
  });

  it('get of a key that was never put rejects', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    await expect(store.get(org, 'never-put.txt')).rejects.toThrow();
  });
});
