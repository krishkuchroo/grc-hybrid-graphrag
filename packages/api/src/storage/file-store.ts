// The small file-store interface (D21, D45.2): uploaded files live in one bucket per org (D53).
export interface FileStore {
  ensureBucket(orgId: string): Promise<void>;
  put(orgId: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(orgId: string, key: string): Promise<Buffer>;
  exists(orgId: string, key: string): Promise<boolean>;
}

export const FILE_STORE = Symbol('FileStore');

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The bucket for an org is `grc-org-<orgId>`. A bad org ID throws before any request (D45.7). */
export function bucketForOrg(orgId: string): string {
  if (typeof orgId !== 'string' || !ORG_ID.test(orgId)) {
    throw new Error('FileStore: the org ID must be a lowercase UUID');
  }
  return `grc-org-${orgId}`;
}

/** An object key stays inside its bucket: not empty, no leading slash, no `.` or `..` segments. */
export function checkKey(key: string): string {
  if (typeof key !== 'string' || key === '' || key.startsWith('/') || key.includes('\\')) {
    throw new Error('FileStore: bad object key');
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('FileStore: bad object key');
  }
  return key;
}
