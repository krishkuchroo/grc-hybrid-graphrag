// Shared set-up for the M0-006 storage tests (D21, D53, D57, D132, D137).
//
// Contract these tests hold the builder to:
// - `packages/api/src/storage/file-store.ts` exports the `FileStore` interface from the brief.
// - `packages/api/src/storage/seaweed-file-store.ts` exports `class SeaweedFileStore implements FileStore`,
//   built as `new SeaweedFileStore({ endpoint, accessKey, secretKey })`. It talks to SeaweedFS's S3 API.
// - The bucket for an org is `grc-org-<orgId>`, where orgId is a lowercase UUID.
// - The one backend-only service key (D57) lives in `.env` as `S3_ACCESS_KEY` and `S3_SECRET_KEY`.
//   Both names contain KEY, so `pnpm setup:secrets` fills them with random values.
//
// Live tests reach SeaweedFS at `S3_ENDPOINT`, default `http://127.0.0.1:8333`, which only the dev
// switch publishes (D132, D137). The service key comes from the environment, else from the `.env`
// in this checkout, else from the `.env` in the main checkout (worktrees have none of their own).
//
// The module is loaded with a dynamic import inside each test, so a missing module fails each test
// on its own with a clear message instead of failing the whole file at load time.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8333';

export interface FileStoreLike {
  ensureBucket(orgId: string): Promise<void>;
  put(orgId: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(orgId: string, key: string): Promise<Buffer>;
  exists(orgId: string, key: string): Promise<boolean>;
}

export interface StoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

type SeaweedCtor = new (config: StoreConfig) => FileStoreLike;

export async function loadSeaweedFileStore(): Promise<SeaweedCtor> {
  const mod = (await import('../../src/storage/seaweed-file-store.js')) as { SeaweedFileStore?: SeaweedCtor };
  if (typeof mod.SeaweedFileStore !== 'function') {
    throw new Error('src/storage/seaweed-file-store.ts must export class SeaweedFileStore');
  }
  return mod.SeaweedFileStore;
}

function parseEnvFile(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map.set(m[1]!, v);
  }
  return map;
}

function mainCheckoutRoot(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) return undefined;
  return dirname(r.stdout.trim());
}

function secret(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const roots = [ROOT, mainCheckoutRoot()].filter((r): r is string => r !== undefined);
  for (const root of roots) {
    const v = parseEnvFile(join(root, '.env')).get(name);
    if (v) return v;
  }
  throw new Error(`${name} is not set: run \`pnpm setup:secrets\` and start the stack with the dev switch (D132)`);
}

export function liveConfig(): StoreConfig {
  return {
    endpoint: process.env.S3_ENDPOINT || DEFAULT_ENDPOINT,
    accessKey: secret('S3_ACCESS_KEY'),
    secretKey: secret('S3_SECRET_KEY'),
  };
}

export async function liveStore(overrides: Partial<StoreConfig> = {}): Promise<FileStoreLike> {
  const SeaweedFileStore = await loadSeaweedFileStore();
  return new SeaweedFileStore({ ...liveConfig(), ...overrides });
}

/** A fresh org ID per test, so each run uses its own buckets. */
export function newOrgId(): string {
  return randomUUID();
}

export function bucketFor(orgId: string): string {
  return `grc-org-${orgId}`;
}

/** An unsigned (anonymous) request straight to the S3 API. */
export async function anonymous(method: string, path: string, body?: Buffer): Promise<Response> {
  const url = `${process.env.S3_ENDPOINT || DEFAULT_ENDPOINT}${path}`;
  try {
    return await fetch(url, { method, body });
  } catch (err) {
    throw new Error(`SeaweedFS S3 API not reachable at ${url}; start the stack with the dev switch (D132)`, {
      cause: err,
    });
  }
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/**
 * A stand-in S3 endpoint on 127.0.0.1 that records every request and answers 200 with an empty body.
 * Used where the tests must see what the store sends (or that it sends nothing).
 */
export async function startRecorder(): Promise<{
  endpoint: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-length': '0', etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
