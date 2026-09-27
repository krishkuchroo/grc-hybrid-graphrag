// M0-006 criterion 4: requests without the service key are refused, and anonymous access is off
// (D53 downloads only through the API, D57 one backend-only service key).
// Live against SeaweedFS at 127.0.0.1:8333 through the dev switch (D132, D137); see helpers.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ROOT,
  anonymous,
  bucketFor,
  liveConfig,
  liveStore,
  loadSeaweedFileStore,
  newOrgId,
  startRecorder,
  removeTestBuckets,
} from './helpers.js';

// Empty and delete every bucket this file made, so runs don't fill grc-seaweedfs-data.
afterAll(removeTestBuckets, 120_000);

const REFUSED = [401, 403];

async function orgWithObject(): Promise<{ org: string; key: string; body: Buffer }> {
  const store = await liveStore();
  const org = newOrgId();
  const key = 'private/evidence.pdf';
  const body = Buffer.from('only the backend may read this');
  await store.ensureBucket(org);
  await store.put(org, key, body, 'application/pdf');
  return { org, key, body };
}

describe('storage: service key (criterion 4)', () => {
  it('.env.example names the service key, so setup:secrets generates it', () => {
    const names = readFileSync(join(ROOT, '.env.example'), 'utf8')
      .split('\n')
      .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined);
    expect(names).toContain('S3_ACCESS_KEY');
    expect(names).toContain('S3_SECRET_KEY');
  });

  it('signs every request with the service key', async () => {
    const SeaweedFileStore = await loadSeaweedFileStore();
    const rec = await startRecorder();
    try {
      const store = new SeaweedFileStore({
        endpoint: rec.endpoint,
        accessKey: 'svc-access-id',
        secretKey: 'svc-secret',
      });
      const org = newOrgId();
      await store.ensureBucket(org).catch(() => undefined);
      await store.put(org, 'a.txt', Buffer.from('x'), 'text/plain').catch(() => undefined);
      await store.exists(org, 'a.txt').catch(() => undefined);
      await store.get(org, 'a.txt').catch(() => undefined);
      expect(rec.requests.length).toBeGreaterThan(0);
      for (const r of rec.requests) {
        expect(String(r.headers.authorization ?? ''), `${r.method} ${r.url} is unsigned`).toMatch(
          /^AWS4-HMAC-SHA256 Credential=svc-access-id\//,
        );
      }
    } finally {
      await rec.close();
    }
  });

  it('an anonymous read of an object is refused', async () => {
    const { org, key } = await orgWithObject();
    const res = await anonymous('GET', `/${bucketFor(org)}/${key}`);
    expect(REFUSED).toContain(res.status);
    expect(await res.text()).not.toContain('only the backend may read this');
  });

  it('an anonymous listing of the bucket is refused', async () => {
    const { org } = await orgWithObject();
    const res = await anonymous('GET', `/${bucketFor(org)}?list-type=2`);
    expect(REFUSED).toContain(res.status);
    expect(await res.text()).not.toContain('evidence.pdf');
  });

  it('an anonymous listing of all buckets is refused', async () => {
    await orgWithObject();
    const res = await anonymous('GET', '/');
    expect(REFUSED).toContain(res.status);
    expect(await res.text()).not.toContain('grc-org-');
  });

  it('an anonymous write is refused and stores nothing', async () => {
    const { org } = await orgWithObject();
    const res = await anonymous('PUT', `/${bucketFor(org)}/planted.txt`, Buffer.from('planted'));
    expect(REFUSED).toContain(res.status);
    const store = await liveStore();
    expect(await store.exists(org, 'planted.txt')).toBe(false);
  });

  it('an anonymous bucket create is refused', async () => {
    const store = await liveStore();
    const org = newOrgId();
    const res = await anonymous('PUT', `/${bucketFor(org)}`);
    expect(REFUSED).toContain(res.status);
    // The service key can still create it afterwards.
    await expect(store.ensureBucket(org)).resolves.toBeUndefined();
  });

  it('a store with a wrong secret is refused on every call', async () => {
    const { org, key } = await orgWithObject();
    const bad = await liveStore({ secretKey: `${liveConfig().secretKey}-wrong` });
    await expect(bad.get(org, key)).rejects.toThrow();
    await expect(bad.put(org, 'bad-secret.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(bad.exists(org, key)).rejects.toThrow();
    await expect(bad.ensureBucket(newOrgId())).rejects.toThrow();
    const good = await liveStore();
    expect(await good.exists(org, 'bad-secret.txt')).toBe(false);
  });

  it('a store with an unknown access key is refused', async () => {
    const { org, key } = await orgWithObject();
    const bad = await liveStore({ accessKey: 'not-the-service-key' });
    await expect(bad.get(org, key)).rejects.toThrow();
    await expect(bad.put(org, 'bad-key.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
  });
});
