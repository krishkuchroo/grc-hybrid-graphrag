// M0-014 criterion 5 (D133): `pnpm org:create` calls provisionOrg, prints the org ID, checks its
// arguments before doing anything, and is safe to run again with the same slug.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOWERCASE_UUID,
  auditActions,
  bucketExists,
  countRows,
  membersOf,
  newOrgInput,
  orgDatabaseStatuses,
  orgsWithSlug,
  runRoot,
  scriptEnv,
  setUpProvision,
  tearDownProvision,
  type ProvEnv,
  type ProvisionInput,
  type RunResult,
} from './helpers.js';

const T = 180_000;

let env: ProvEnv;

beforeAll(async () => {
  env = await setUpProvision();
}, T);

afterAll(async () => {
  await tearDownProvision(env);
}, T);

function argsFor(input: ProvisionInput): string[] {
  return [
    '--name',
    input.name,
    '--slug',
    input.slug,
    '--admin-email',
    input.admin.email,
    '--admin-name',
    input.admin.name,
  ];
}

function orgCreate(args: string[]): Promise<RunResult> {
  return runRoot('org:create', args, scriptEnv(env));
}

function output(r: RunResult): string {
  return `${r.stdout}\n${r.stderr}`;
}

describe('pnpm org:create with valid arguments', { timeout: T }, () => {
  let input: ProvisionInput;
  let first: RunResult;
  let orgId: string;

  beforeAll(async () => {
    input = newOrgInput('cli');
    first = await orgCreate(argsFor(input));
    orgId = (await orgsWithSlug(env, input.slug))[0]?.id ?? '';
  }, T);

  it('exits 0', () => {
    expect(first.status, output(first)).toBe(0);
  });

  it('creates the org in Postgres, with the given name', async () => {
    expect(await orgsWithSlug(env, input.slug)).toEqual([{ id: orgId, name: input.name }]);
    expect(orgId).toMatch(LOWERCASE_UUID);
  });

  it('prints the new org ID', () => {
    expect(orgId).toMatch(LOWERCASE_UUID);
    expect(first.stdout).toContain(orgId);
  });

  it('provisions everywhere through provisionOrg: Neo4j database, bucket, first Admin, org.created', async () => {
    expect(await orgDatabaseStatuses(orgId)).toContain('online');
    expect(await bucketExists(orgId)).toBe(true);
    const members = await membersOf(env, orgId);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      email: input.admin.email,
      name: input.admin.name,
      role: 'admin',
      clearance: 'restricted',
    });
    expect((await auditActions(env, orgId)).filter((a) => a.action === 'org.created')).toHaveLength(1);
  });

  it('running it again with the same slug exits 0, prints the same ID and duplicates nothing', async () => {
    const again = await orgCreate(argsFor(input));
    expect(again.status, output(again)).toBe(0);
    expect(again.stdout).toContain(orgId);
    expect(await orgsWithSlug(env, input.slug)).toHaveLength(1);
    expect(await membersOf(env, orgId)).toHaveLength(1);
    expect((await auditActions(env, orgId)).filter((a) => a.action === 'org.created')).toHaveLength(1);
  });
});

describe('pnpm org:create with missing or invalid arguments', { timeout: T }, () => {
  const base = (): ProvisionInput => newOrgInput('badargs');

  async function expectRefused(args: string[], flag: string, slug: string): Promise<void> {
    const orgsBefore = await countRows(env, 'organization');
    const usersBefore = await countRows(env, 'user');
    const r = await orgCreate(args);
    expect(r.status, output(r)).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(output(r)).toContain(flag);
    expect(await countRows(env, 'organization')).toBe(orgsBefore);
    expect(await countRows(env, 'user')).toBe(usersBefore);
    expect(await orgsWithSlug(env, slug)).toEqual([]);
  }

  const flags = ['--name', '--slug', '--admin-email', '--admin-name'] as const;

  it.each(flags)('without %s: exits non-zero, names the flag, creates nothing', async (flag) => {
    const input = base();
    const args = argsFor(input);
    const i = args.indexOf(flag);
    args.splice(i, 2);
    await expectRefused(args, flag, input.slug);
  });

  it.each(flags)('with an empty %s: exits non-zero, names the flag, creates nothing', async (flag) => {
    const input = base();
    const args = argsFor(input);
    args[args.indexOf(flag) + 1] = '';
    await expectRefused(args, flag, input.slug);
  });

  it.each(['Not A Slug!', 'UPPER-case', '-leading-hyphen', 'double--hyphen', 'org/../x'])(
    'with the invalid slug %j: exits non-zero, names --slug, creates nothing',
    async (slug) => {
      const input = base();
      const args = argsFor(input);
      args[args.indexOf('--slug') + 1] = slug;
      await expectRefused(args, '--slug', slug);
    },
  );

  it.each(['not-an-email', 'missing-domain@', '@no-local-part.test'])(
    'with the invalid admin email %j: exits non-zero, names --admin-email, creates nothing',
    async (email) => {
      const input = base();
      const args = argsFor(input);
      args[args.indexOf('--admin-email') + 1] = email;
      await expectRefused(args, '--admin-email', input.slug);
    },
  );

  it('with no arguments at all: exits non-zero, names the flags it needs, creates nothing', async () => {
    const orgsBefore = await countRows(env, 'organization');
    const r = await orgCreate([]);
    expect(r.status, output(r)).not.toBe(0);
    expect(r.status).not.toBeNull();
    for (const flag of flags) expect(output(r)).toContain(flag);
    expect(await countRows(env, 'organization')).toBe(orgsBefore);
  });
});
