// M0-014 criteria 1–3: provisionOrg creates an org everywhere at once, safely re-runnable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOWERCASE_UUID,
  auditActions,
  auditPartitions,
  bucketExists,
  credentialsOf,
  deps,
  loadProvisionOrg,
  membersOf,
  newOrgInput,
  orgDatabaseStatuses,
  orgsWithSlug,
  setUpProvision,
  tearDownProvision,
  usersWithEmail,
  type ProvEnv,
  type ProvisionInput,
  type ProvisionOrg,
} from './helpers.js';

const T = 180_000;

let env: ProvEnv;
let provisionOrg: ProvisionOrg;

beforeAll(async () => {
  env = await setUpProvision();
}, T);

afterAll(async () => {
  await tearDownProvision(env);
}, T);

async function load(): Promise<ProvisionOrg> {
  provisionOrg ??= await loadProvisionOrg();
  return provisionOrg;
}

// Everything criterion 1 lists, plus criterion 3, for one org: exactly once each.
async function expectFullyProvisioned(input: ProvisionInput, orgId: string): Promise<void> {
  const orgs = await orgsWithSlug(env, input.slug);
  expect(orgs).toEqual([{ id: orgId, name: input.name }]);
  expect(await auditPartitions(env, orgId)).toBe(1);
  expect(await orgDatabaseStatuses(orgId)).toEqual(expect.arrayContaining(['online']));
  expect(await bucketExists(orgId)).toBe(true);
  expect(await usersWithEmail(env, input.admin.email)).toBe(1);
  const members = await membersOf(env, orgId);
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({ email: input.admin.email, role: 'admin', clearance: 'restricted' });
  const created = (await auditActions(env, orgId)).filter((a) => a.action === 'org.created');
  expect(created).toHaveLength(1);
  expect(await env.audit.verifyChain(orgId)).toEqual({ ok: true });
}

describe('provisionOrg: one call creates the org everywhere (criterion 1)', { timeout: T }, () => {
  let input: ProvisionInput;
  let orgId: string;

  beforeAll(async () => {
    input = newOrgInput('first');
    ({ orgId } = await (await load())(input, deps(env)));
  }, T);

  it('returns a lowercase UUID as the org ID', () => {
    expect(orgId).toMatch(LOWERCASE_UUID);
  });

  it('creates the Postgres org with the given name and slug', async () => {
    expect(await orgsWithSlug(env, input.slug)).toEqual([{ id: orgId, name: input.name }]);
  });

  it("creates the org's audit partition", async () => {
    expect(await auditPartitions(env, orgId)).toBe(1);
  });

  it('creates org-<orgId> in Neo4j, online', async () => {
    const statuses = await orgDatabaseStatuses(orgId);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'online')).toBe(true);
  });

  it('creates grc-org-<orgId> in storage', async () => {
    expect(await bucketExists(orgId)).toBe(true);
  });

  it('creates the first Admin: the given email and name, role admin, clearance restricted', async () => {
    const members = await membersOf(env, orgId);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      email: input.admin.email,
      name: input.admin.name,
      role: 'admin',
      clearance: 'restricted',
    });
  });

  it('leaves the first Admin with no password and no MFA, so both are set at first sign-in', async () => {
    const [admin] = await membersOf(env, orgId);
    const creds = await credentialsOf(env, admin!.userId);
    expect(creds.passwords).toEqual([]);
    expect(creds.twoFactorEnabled).not.toBe(true);
    expect(creds.twoFactorRows).toBe(0);
  });
});

describe('provisionOrg: the org.created audit event (criterion 3)', { timeout: T }, () => {
  it("writes one org.created event into the new org's own chain, and the chain verifies", async () => {
    const input = newOrgInput('audited');
    const { orgId } = await (await load())(input, deps(env));
    const actions = await auditActions(env, orgId);
    expect(actions.filter((a) => a.action === 'org.created')).toHaveLength(1);
    expect(actions[0]!.seq).toBe(1);
    expect(await env.audit.verifyChain(orgId)).toEqual({ ok: true });
  });
});

describe('provisionOrg: safe to re-run (criterion 2)', { timeout: T }, () => {
  it('a second call with the same slug returns the same org ID and duplicates nothing', async () => {
    const provision = await load();
    const input = newOrgInput('rerun');
    const first = await provision(input, deps(env));
    const second = await provision(input, deps(env));
    expect(second.orgId).toBe(first.orgId);
    await expectFullyProvisioned(input, first.orgId);
  });

  it('a failure injected after the Neo4j step fails the call, and a re-run finishes every missing step', async () => {
    const provision = await load();
    const input = newOrgInput('neo4jfail');
    const failing = {
      createOrgDatabase: async (orgId: string) => {
        await env.graph.createOrgDatabase(orgId);
        throw new Error('injected failure after the Neo4j step');
      },
    };
    await expect(provision(input, deps(env, { graph: failing }))).rejects.toThrow();

    const { orgId } = await provision(input, deps(env));
    expect(orgId).toMatch(LOWERCASE_UUID);
    await expectFullyProvisioned(input, orgId);
  });

  it('a storage failure fails the call, and a re-run creates the bucket and duplicates nothing', async () => {
    const provision = await load();
    const input = newOrgInput('bucketfail');
    const failing = {
      ensureBucket: async () => {
        throw new Error('injected storage failure');
      },
    };
    await expect(provision(input, deps(env, { files: failing }))).rejects.toThrow();
    const left = await orgsWithSlug(env, input.slug);
    for (const org of left) expect(await bucketExists(org.id)).toBe(false);

    const { orgId } = await provision(input, deps(env));
    if (left.length > 0) expect(orgId).toBe(left[0]!.id);
    await expectFullyProvisioned(input, orgId);
  });
});
