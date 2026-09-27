// M0-006 criterion 1: `ensureBucket` is safe to run twice (D45.5 re-runs are safe, D53 a bucket per org).
// Live against SeaweedFS at 127.0.0.1:8333 through the dev switch (D132, D137); see helpers.ts.
import { describe, expect, it } from 'vitest';
import { bucketFor, liveStore, loadSeaweedFileStore, newOrgId, startRecorder } from './helpers.js';

describe('storage: ensureBucket (criterion 1)', () => {
  it('creates the org bucket, and a second call resolves without error', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await expect(store.ensureBucket(org)).resolves.toBeUndefined();
    await expect(store.ensureBucket(org)).resolves.toBeUndefined();
  });

  it('two calls at the same time both resolve', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await expect(Promise.all([store.ensureBucket(org), store.ensureBucket(org)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('a repeat call keeps the objects already in the bucket', async () => {
    const store = await liveStore();
    const org = newOrgId();
    await store.ensureBucket(org);
    const body = Buffer.from('kept across ensureBucket re-runs');
    await store.put(org, 'keep/me.txt', body, 'text/plain');
    await store.ensureBucket(org);
    expect(await store.exists(org, 'keep/me.txt')).toBe(true);
    expect((await store.get(org, 'keep/me.txt')).equals(body)).toBe(true);
  });

  it('addresses the bucket named grc-org-<orgId>', async () => {
    const SeaweedFileStore = await loadSeaweedFileStore();
    const rec = await startRecorder();
    try {
      const store = new SeaweedFileStore({
        endpoint: rec.endpoint,
        accessKey: 'recorder-key',
        secretKey: 'recorder-secret',
      });
      const org = newOrgId();
      await store.ensureBucket(org).catch(() => undefined);
      expect(rec.requests.length).toBeGreaterThan(0);
      const bucket = bucketFor(org);
      for (const r of rec.requests) {
        const path = r.url.split('?')[0]!;
        const host = String(r.headers.host ?? '');
        const named = path === `/${bucket}` || path.startsWith(`/${bucket}/`) || host.startsWith(`${bucket}.`);
        expect(named, `${r.method} ${r.url} (host ${host}) does not address ${bucket}`).toBe(true);
      }
    } finally {
      await rec.close();
    }
  });
});
