// M0-014 criterion 4 (D114): `pnpm seed:demo` creates two orgs, each with one user per role, at
// mixed clearances, with a printed login list. The password comes from DEMO_USER_PASSWORD
// (the environment or `.env`), never from the code, and is never printed.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLES,
  allOrgIds,
  auditActions,
  bucketExists,
  countRows,
  credentialsOf,
  membersOf,
  orgDatabaseStatuses,
  runRoot,
  scriptEnv,
  setUpProvision,
  tearDownProvision,
  type MemberRow,
  type ProvEnv,
  type RunResult,
} from './helpers.js';

const T = 300_000;
const PASSWORD = `demo-${randomBytes(18).toString('base64url')}`;

let env: ProvEnv;

beforeAll(async () => {
  env = await setUpProvision();
}, T);

afterAll(async () => {
  await tearDownProvision(env);
}, T);

function seed(password: string): Promise<RunResult> {
  return runRoot('seed:demo', [], scriptEnv(env, { DEMO_USER_PASSWORD: password }));
}

function output(r: RunResult): string {
  return `${r.stdout}\n${r.stderr}`;
}

describe('pnpm seed:demo refuses a weak password', { timeout: T }, () => {
  it('with a DEMO_USER_PASSWORD under 12 characters: exits non-zero, names the setting, creates nothing', async () => {
    const r = await seed('short-pw1');
    expect(r.status, output(r)).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(output(r)).toContain('DEMO_USER_PASSWORD');
    expect(await countRows(env, 'organization')).toBe(0);
    expect(await countRows(env, 'user')).toBe(0);
  });
});

describe('pnpm seed:demo', { timeout: T }, () => {
  let run: RunResult;
  let orgIds: string[];
  const members = new Map<string, MemberRow[]>();

  beforeAll(async () => {
    run = await seed(PASSWORD);
    orgIds = await allOrgIds(env);
    for (const id of orgIds) members.set(id, await membersOf(env, id));
  }, T);

  it('exits 0', () => {
    expect(run.status, output(run)).toBe(0);
  });

  it('creates exactly two orgs', () => {
    expect(orgIds).toHaveLength(2);
  });

  it('gives each org one user per role: 7 users, each role exactly once', () => {
    expect(orgIds).toHaveLength(2);
    for (const id of orgIds) {
      const m = members.get(id)!;
      expect(m).toHaveLength(7);
      expect(m.map((x) => x.role).sort()).toEqual([...ROLES].sort());
      expect(new Set(m.map((x) => x.userId)).size).toBe(7);
    }
  });

  it('uses 14 different users across the two orgs', async () => {
    const all = orgIds.flatMap((id) => members.get(id)!.map((x) => x.userId));
    expect(all).toHaveLength(14);
    expect(new Set(all).size).toBe(14);
    expect(await countRows(env, 'user')).toBe(14);
  });

  it('gives each org mixed clearances, with its Admin at restricted', () => {
    expect(orgIds).toHaveLength(2);
    for (const id of orgIds) {
      const m = members.get(id)!;
      expect(new Set(m.map((x) => x.clearance)).size).toBeGreaterThanOrEqual(2);
      expect(m.find((x) => x.role === 'admin')?.clearance).toBe('restricted');
    }
  });

  it('provisions each org fully: Neo4j database, bucket and an org.created event', async () => {
    expect(orgIds).toHaveLength(2);
    for (const id of orgIds) {
      expect(await orgDatabaseStatuses(id)).toContain('online');
      expect(await bucketExists(id)).toBe(true);
      expect((await auditActions(env, id)).filter((a) => a.action === 'org.created')).toHaveLength(1);
      expect(await env.audit.verifyChain(id)).toEqual({ ok: true });
    }
  });

  it('gives every demo user a stored, hashed password (a Better Auth credential account)', async () => {
    const users = orgIds.flatMap((id) => members.get(id)!);
    expect(users).toHaveLength(14);
    for (const u of users) {
      const creds = await credentialsOf(env, u.userId);
      expect(creds.passwords).toHaveLength(1);
      expect(creds.passwords[0]!.providerId).toBe('credential');
      expect(creds.passwords[0]!.password).not.toContain(PASSWORD);
    }
  });

  it('prints a login list with every demo email', () => {
    const users = orgIds.flatMap((id) => members.get(id)!);
    expect(users).toHaveLength(14);
    for (const u of users) expect(run.stdout).toContain(u.email);
  });

  it('never prints the password', () => {
    expect(run.status).toBe(0);
    expect(output(run)).not.toContain(PASSWORD);
  });

  it('running it again is safe: still two orgs, 7 members each, 14 users, one org.created each', async () => {
    const again = await seed(PASSWORD);
    expect(again.status, output(again)).toBe(0);
    const ids = await allOrgIds(env);
    expect(ids.sort()).toEqual([...orgIds].sort());
    for (const id of ids) {
      expect(await membersOf(env, id)).toHaveLength(7);
      expect((await auditActions(env, id)).filter((a) => a.action === 'org.created')).toHaveLength(1);
    }
    expect(await countRows(env, 'user')).toBe(14);
  });
});
