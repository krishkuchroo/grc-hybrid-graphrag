// S1-002 criterion 6 (D73, D45.5, D133, D170, D164, D176): `pnpm graph:schema` applies the D73
// schema to every existing org and exits 0. With one org's database missing, it names that org as
// failed, carries on with the others, and exits non-zero. It prints only org IDs and OK or failed.
//
// Contract (TASKS.md, brief S1-002): root script `graph:schema` runs
// `packages/infra/scripts/graph-schema.ts`. It finds the orgs the way the outbox relay does
// (`AuditService.orgIds()`: every org with an audit partition), applies `ensureOrgSchema` to each,
// and swaps the container Postgres host for 127.0.0.1:5433 itself (D170). Settings come from the
// environment first, then `.env` (the same ones as `pnpm org:create`).
//
// Throwaway data only (D82, D176): each describe gets its own migrated `test-…` Postgres database
// (the M0-014 provision helpers) and its own `org-<uuid>` Neo4j databases, dropped in afterAll.
// An org is made here as its audit partition plus its Neo4j database (no schema yet). The
// "missing database" org is an audit partition with no Neo4j database at all: no real org's
// database is ever dropped or broken. The expected names are in api's tests/org-schema/expected.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphTestEnv } from '../../../api/tests/graph/helpers.js';
import { expectFullSchema, expectNoSchema, readSchema } from '../../../api/tests/org-schema/helpers.js';
import {
  runRoot,
  scriptEnv,
  setUpProvision,
  tearDownProvision,
  type ProvEnv,
  type RunResult,
} from '../../../api/tests/provision/helpers.js';

const T = 300_000;

interface Fixture {
  env: ProvEnv;
}

async function setUp(): Promise<Fixture> {
  return { env: await setUpProvision() };
}

/** tearDownProvision drops every tracked `org-<uuid>` database with dropAll (S1-014). */
async function tearDown(f: Fixture | undefined): Promise<void> {
  if (!f) return;
  await tearDownProvision(f.env);
}

type AuditModule = { createAuditPartition(db: unknown, orgId: string): Promise<void> };

/** An org the relay would see: its audit partition, and (unless `withDatabase` is false) `org-<id>`. */
async function addOrg(f: Fixture, orgId: string, withDatabase = true): Promise<string> {
  const { createAuditPartition } = (await import('../../../api/src/audit/audit.service.js')) as AuditModule;
  await createAuditPartition(f.env.migrator, orgId);
  f.env.databases.track(`org-${orgId}`);
  if (withDatabase) await f.env.graph.createOrgDatabase(orgId);
  return orgId;
}

function graphSchema(f: Fixture, extra: Record<string, string> = {}): Promise<RunResult> {
  return runRoot('graph:schema', [], scriptEnv(f.env, extra));
}

function output(r: RunResult): string {
  return `${r.stdout}\n${r.stderr}`;
}

function lineFor(r: RunResult, orgId: string): string {
  return output(r)
    .split('\n')
    .filter((l) => l.includes(orgId))
    .join('\n');
}

/** D164: no secret or address in the output. */
function expectNoValues(r: RunResult, f: Fixture): void {
  const text = output(r);
  const env = scriptEnv(f.env);
  const g = graphTestEnv();
  for (const secret of [g.adminPassword, g.writerPassword, g.desktopPassword, env['S3_SECRET_KEY'] ?? '']) {
    if (secret) expect(text.includes(secret), 'a secret was printed').toBe(false);
  }
  for (const url of [env['DATABASE_URL_APP'] ?? '', env['DATABASE_URL_MIGRATE'] ?? '']) {
    const password = decodeURIComponent(new URL(url).password);
    if (password) expect(text.includes(password), 'a Postgres password was printed').toBe(false);
  }
  expect(text).not.toContain('postgres://');
}

describe('pnpm graph:schema with every org database present (criterion 6)', { timeout: T }, () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setUp();
    // Orgs already there before this describe's tests, so each run covers more than one org.
    await addOrg(f, randomUUID());
    await addOrg(f, randomUUID());
  }, T);

  afterAll(async () => {
    await tearDown(f);
  }, T);

  it('applies the schema to every org, prints each org ID with OK, and exits 0', async () => {
    const a = await addOrg(f, randomUUID());
    const b = await addOrg(f, randomUUID());
    expectNoSchema(await readSchema(a));
    expectNoSchema(await readSchema(b));

    const run = await graphSchema(f);

    expect(run.status, output(run)).toBe(0);
    for (const org of [a, b]) {
      expectFullSchema(await readSchema(org));
      expect(lineFor(run, org), output(run)).toMatch(/\bOK\b/);
      expect(lineFor(run, org), output(run)).not.toMatch(/fail/i);
    }
    expectNoValues(run, f);
  });

  it('a second run is safe: exits 0, and every org still has the full schema', async () => {
    const a = await addOrg(f, randomUUID());
    const first = await graphSchema(f);
    expect(first.status, output(first)).toBe(0);
    const second = await graphSchema(f);
    expect(second.status, output(second)).toBe(0);
    expect(lineFor(second, a), output(second)).toMatch(/\bOK\b/);
    expectFullSchema(await readSchema(a));
  });

  it('swaps a container Postgres address (grc-postgres:5432) for 127.0.0.1:5433 itself (D170)', async () => {
    const a = await addOrg(f, randomUUID());
    const env = scriptEnv(f.env);
    const toContainer = (url: string): string => {
      const u = new URL(url);
      u.hostname = 'grc-postgres';
      u.port = '5432';
      return u.toString();
    };
    const run = await graphSchema(f, {
      DATABASE_URL_APP: toContainer(env['DATABASE_URL_APP']!),
      DATABASE_URL_MIGRATE: toContainer(env['DATABASE_URL_MIGRATE']!),
    });
    expect(run.status, output(run)).toBe(0);
    expect(lineFor(run, a), output(run)).toMatch(/\bOK\b/);
    expectFullSchema(await readSchema(a));
    expectNoValues(run, f);
  });
});

describe('pnpm graph:schema with one org database missing (criterion 6)', { timeout: T }, () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setUp();
  }, T);

  afterAll(async () => {
    await tearDown(f);
  }, T);

  it('names the missing org as failed, still applies the schema to the others, and exits non-zero', async () => {
    // The missing one sorts first, so the others come after the failure.
    const missing = await addOrg(f, `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, false);
    const a = await addOrg(f, randomUUID());
    const b = await addOrg(f, randomUUID());
    expectNoSchema(await readSchema(a));
    expectNoSchema(await readSchema(b));

    const run = await graphSchema(f);

    expect(run.status, output(run)).not.toBe(0);
    expect(run.status, output(run)).not.toBeNull();
    expect(lineFor(run, missing), output(run)).toMatch(/fail/i);
    for (const org of [a, b]) {
      expect(lineFor(run, org), output(run)).toMatch(/\bOK\b/);
      expectFullSchema(await readSchema(org));
    }
    expectNoValues(run, f);
  });
});
