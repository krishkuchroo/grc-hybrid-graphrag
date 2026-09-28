// M0-006 criterion 5: a bad org ID throws before any request (D45.7 fail safe).
// An org ID is a lowercase UUID (M0 shared notes). The store points at a local recorder, so the test
// sees that nothing was sent. No SeaweedFS needed.
import { describe, expect, it } from 'vitest';
import { loadSeaweedFileStore, newOrgId, startRecorder, type FileStoreLike } from './helpers.js';

const good = newOrgId();

const BAD_ORG_IDS: Array<[string, unknown]> = [
  ['empty', ''],
  ['blank', '   '],
  ['not a UUID', 'acme'],
  ['UUID in upper case', good.toUpperCase()],
  ['UUID with a space after it', `${good} `],
  ['UUID without dashes', good.replaceAll('-', '')],
  ['UUID one character short', good.slice(0, -1)],
  ['bucket name instead of org ID', `grc-org-${good}`],
  ['path walking out', `../${good}`],
  ['slash inside', `${good.slice(0, 8)}/${good.slice(9)}`],
  ['wildcard', '*'],
  ['undefined', undefined],
  ['null', null],
  ['number', 42],
];

type Call = [name: string, run: (store: FileStoreLike, orgId: string) => Promise<unknown>];

const CALLS: Call[] = [
  ['ensureBucket', (s, o) => s.ensureBucket(o)],
  ['put', (s, o) => s.put(o, 'a.txt', Buffer.from('x'), 'text/plain')],
  ['get', (s, o) => s.get(o, 'a.txt')],
  ['exists', (s, o) => s.exists(o, 'a.txt')],
];

describe('storage: org ID check (criterion 5)', () => {
  for (const [callName, call] of CALLS) {
    for (const [label, orgId] of BAD_ORG_IDS) {
      it(`${callName} with ${label} throws and sends no request`, async () => {
        const SeaweedFileStore = await loadSeaweedFileStore();
        const rec = await startRecorder();
        try {
          const store = new SeaweedFileStore({ endpoint: rec.endpoint, accessKey: 'k', secretKey: 's' });
          await expect((async () => call(store, orgId as string))()).rejects.toThrow();
          expect(rec.requests, `${callName} sent a request for a bad org ID`).toEqual([]);
        } finally {
          await rec.close();
        }
      });
    }
  }

  it('a good lowercase UUID does reach the endpoint (the check is not refusing everything)', async () => {
    const SeaweedFileStore = await loadSeaweedFileStore();
    const rec = await startRecorder();
    try {
      const store = new SeaweedFileStore({ endpoint: rec.endpoint, accessKey: 'k', secretKey: 's' });
      await store.exists(good, 'a.txt').catch(() => undefined);
      expect(rec.requests.length).toBeGreaterThan(0);
    } finally {
      await rec.close();
    }
  });
});
