// S1-010 criteria 1-3 (D114, D45.5, D45.8, D37, D45.4, D50, D51, D170, D176): `pnpm seed:demo`
// adds a fixed, re-runnable set of records and links to each demo org, through RecordsService and
// LinksService, so each one is audited like any change.
//
// Contract these tests hold the code to (TASKS.md, brief S1-010):
// - After the orgs and users (M0-014), `packages/infra/scripts/seed-demo.ts` adds to each demo org
//   about 12 assets, 8 risks, 10 controls, 4 policies and 5 incidents, with links of all six types
//   (HOSTS|RUNS, EXPOSED_TO, MITIGATED_BY, GOVERNED_BY, IMPACTS, EXPOSES). The data sits in
//   `packages/infra/scripts/demo-records.ts` as plain objects.
//   - Labels spread from `public` to `restricted`: the risks carry all four, so the demo users'
//     mixed clearances (Viewer public, Control Owner internal, Risk Manager confidential, Admin
//     restricted) see different registers, and a restricted risk exists for the e2e journey.
//   - At least 3 controls are owned by the org's demo Control Owner, at a label their `internal`
//     clearance sees; at least one control is owned by someone else, so "only their own" shows.
//   - The two orgs' data differ, so the org wall is visible.
// - Every record has a fixed `sourceIds` entry (for example `demo:RSK-01`), unique in its org, so a
//   re-run finds it and adds nothing: the same records, numbers, versions and links, and no new
//   audit entries (D45.5).
// - Every record has its `record.created` entry and every link its `link.created` entry in the
//   Postgres audit trail, once the relay has copied the org's outbox (D37), and the chain verifies.
//
// Throwaway data (D82, D176): the seed runs against this file's throwaway Postgres database. The org
// IDs come from the slugs (provisionOrg, a name-based UUID), so with the live slugs `demo-acme` and
// `demo-globex` the seed would write into, and the clean-up would drop, the live demo orgs' Neo4j
// databases and buckets. So the seed reads one optional setting, `DEMO_ORG_SLUG_SUFFIX` (default
// empty): when set, each demo org's slug becomes `<slug>-<suffix>` (lowercase letters and digits),
// and nothing else changes. These tests set a fresh random suffix, refuse to run the seed at all if
// seed-demo.ts doesn't read that setting, and drop only orgs whose slug carries the suffix.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, rows } from '../db/helpers.js';
import { ROOT, runOn, superDriver } from '../graph/helpers.js';
import { tearDownWall } from '../org-wall/helpers.js';
import {
  membersOf,
  runRoot,
  scriptEnv,
  setUpProvision,
  tearDownProvision,
  type ProvEnv,
  type RunResult,
} from './helpers.js';

const T = 300_000;
const PASSWORD = `demo-${randomBytes(18).toString('base64url')}`;
const SUFFIX = `t${randomBytes(4).toString('hex')}`;
const SEED_SCRIPT = join(ROOT, 'packages', 'infra', 'scripts', 'seed-demo.ts');

const KINDS = ['asset', 'risk', 'control', 'policy', 'incident'] as const;
type Kind = (typeof KINDS)[number];
const NODE_LABEL: Record<Kind, string> = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
};
const LINK_ENDS: Record<string, [Kind, Kind]> = {
  HOSTS: ['asset', 'asset'],
  RUNS: ['asset', 'asset'],
  EXPOSED_TO: ['asset', 'risk'],
  MITIGATED_BY: ['risk', 'control'],
  GOVERNED_BY: ['control', 'policy'],
  IMPACTS: ['incident', 'asset'],
  EXPOSES: ['incident', 'risk'],
};
const LINK_NAMES = Object.keys(LINK_ENDS);
const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

/** "About 12 assets, 8 risks, 10 controls, 4 policies and 5 incidents per demo org." */
const ABOUT: Record<Kind, [number, number]> = {
  asset: [10, 14],
  risk: [6, 10],
  control: [8, 12],
  policy: [3, 5],
  incident: [4, 6],
};

interface Rec {
  kind: Kind;
  id: string;
  number: string;
  name: string;
  label: string;
  owner: string;
  version: number;
  sourceIds: string[];
}

interface Link {
  type: string;
  fromId: string;
  toId: string;
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

interface Snapshot {
  records: Rec[];
  links: Link[];
}

let env: ProvEnv | undefined;
let firstRun: Promise<RunResult> | undefined;

function e(): ProvEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

beforeAll(async () => {
  env = await setUpProvision();
}, T);

afterAll(async () => {
  if (!env) return;
  let orgs: Org[] = [];
  try {
    orgs = await orgsIn(env);
  } catch {
    // the organization table may be missing if the set-up failed early
  }
  if (orgs.every((o) => o.slug.endsWith(`-${SUFFIX}`))) {
    await tearDownProvision(env); // drops these orgs' Neo4j databases and buckets
  } else {
    // An org without the suffix is a live demo org's ID: close the connections, drop nothing.
    await env.graph.close();
    await closeDb(env.appDb);
    await closeDb(env.migrator);
    await tearDownWall(env.wall);
  }
}, T);

function output(r: RunResult): string {
  return `${r.stdout}\n${r.stderr}`;
}

function seed(): Promise<RunResult> {
  if (!readFileSync(SEED_SCRIPT, 'utf8').includes('DEMO_ORG_SLUG_SUFFIX')) {
    throw new Error(
      'seed-demo.ts does not read DEMO_ORG_SLUG_SUFFIX, so a test run would write into the live demo orgs ' +
        '(their IDs come from the slugs); the seed was not run',
    );
  }
  return runRoot('seed:demo', [], scriptEnv(e(), { DEMO_USER_PASSWORD: PASSWORD, DEMO_ORG_SLUG_SUFFIX: SUFFIX }));
}

/** The first seed run, shared by the tests; each test awaits it, so a failure fails every test. */
async function seededOnce(): Promise<RunResult> {
  firstRun ??= seed();
  const run = await firstRun;
  if (run.status !== 0) throw new Error(`pnpm seed:demo exited ${run.status}:\n${output(run)}`);
  await relayAll();
  return run;
}

async function orgsIn(p: ProvEnv): Promise<Org[]> {
  const { sql } = p.wall.loaded;
  return rows<Org>(p.sup, sql`SELECT id::text AS id, name, slug FROM "organization" ORDER BY name`);
}

async function demoOrgs(): Promise<{ acme: Org; globex: Org }> {
  const orgs = await orgsIn(e());
  const acme = orgs.find((o) => o.name === 'Acme Corp');
  const globex = orgs.find((o) => o.name === 'Globex Ltd');
  if (!acme || !globex) throw new Error(`the seed made these orgs: ${orgs.map((o) => o.name).join(', ')}`);
  return { acme, globex };
}

/** Copies every org's outbox to the Postgres audit trail, as the worker's relay does (D37). */
async function relayAll(): Promise<void> {
  const { OutboxRelay } = await import('../../src/audit/outbox-relay.job.js');
  const { AUDIT_OUTBOX_LABEL } = await import('../../src/graph/privileges.js');
  const orgs = await orgsIn(e());
  const relay = new OutboxRelay({
    graph: e().graph as never,
    audit: e().audit as never,
    orgIds: async () => orgs.map((o) => o.id),
  });
  const driver = superDriver();
  try {
    for (let pass = 0; pass < 20; pass += 1) {
      let left = 0;
      for (const org of orgs) {
        const [r] = await runOn(driver, `org-${org.id}`, `MATCH (o:${AUDIT_OUTBOX_LABEL}) RETURN count(o) AS n`);
        left += Number(r?.['n'] ?? 0);
      }
      if (left === 0) return;
      await relay.runOnce();
    }
    throw new Error('the audit outbox did not empty after 20 relay passes');
  } finally {
    await driver.close();
  }
}

async function snapshot(orgId: string): Promise<Snapshot> {
  const driver = superDriver();
  try {
    const found = await runOn(
      driver,
      `org-${orgId}`,
      `MATCH (n) WHERE n:Asset OR n:Risk OR n:Control OR n:Policy OR n:Incident
       RETURN labels(n) AS labels, n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label,
              n.owner AS owner, n.version AS version, n.sourceIds AS sourceIds`,
    );
    const records = found
      .map((r) => {
        const labels = r['labels'] as string[];
        const kind = KINDS.find((k) => labels.includes(NODE_LABEL[k]));
        return {
          kind: kind!,
          id: String(r['id']),
          number: String(r['number']),
          name: String(r['name']),
          label: String(r['label']),
          owner: String(r['owner']),
          version: Number(r['version']),
          sourceIds: ((r['sourceIds'] as string[] | null) ?? []).map(String).sort(),
        };
      })
      .sort((a, b) => a.number.localeCompare(b.number));
    const linked = await runOn(
      driver,
      `org-${orgId}`,
      `MATCH (a)-[r]->(b) WHERE type(r) IN $types RETURN type(r) AS type, a.id AS fromId, b.id AS toId`,
      { types: LINK_NAMES },
    );
    const links = linked
      .map((r) => ({ type: String(r['type']), fromId: String(r['fromId']), toId: String(r['toId']) }))
      .sort((a, b) => `${a.type}:${a.fromId}:${a.toId}`.localeCompare(`${b.type}:${b.fromId}:${b.toId}`));
    return { records, links };
  } finally {
    await driver.close();
  }
}

interface AuditRow {
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown> | null;
}

async function auditRows(orgId: string): Promise<AuditRow[]> {
  const { sql } = e().wall.loaded;
  return rows<AuditRow>(
    e().sup,
    sql`SELECT action, target_type AS "targetType", target_id AS "targetId", meta
        FROM "audit_events" WHERE org_id = ${orgId}::uuid ORDER BY seq`,
  );
}

function ofKind(s: Snapshot, kind: Kind): Rec[] {
  return s.records.filter((r) => r.kind === kind);
}

async function controlOwnerOf(orgId: string): Promise<string> {
  const owner = (await membersOf(e(), orgId)).find((m) => m.role === 'control_owner');
  if (!owner) throw new Error('the org has no demo Control Owner');
  return owner.userId;
}

describe('criterion 1: what `pnpm seed:demo` adds to each demo org', { timeout: T }, () => {
  it('exits 0, and the demo orgs carry the test suffix (so the live demo orgs are never touched)', async () => {
    const run = await seededOnce();
    expect(run.status, output(run)).toBe(0);
    const orgs = await orgsIn(e());
    expect(orgs.map((o) => o.name).sort()).toEqual(['Acme Corp', 'Globex Ltd']);
    for (const org of orgs) expect(org.slug).toMatch(new RegExp(`-${SUFFIX}$`));
  });

  it('about 12 assets, 8 risks, 10 controls, 4 policies and 5 incidents in each org', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      for (const kind of KINDS) {
        const n = ofKind(s, kind).length;
        const [min, max] = ABOUT[kind];
        expect(n, `${org.name}: ${kind} count`).toBeGreaterThanOrEqual(min);
        expect(n, `${org.name}: ${kind} count`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('links of all six types in each org, each one the ontology allows', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      const kindOf = new Map(s.records.map((r) => [r.id, r.kind]));
      const types = new Set(s.links.map((l) => l.type));
      expect(types.has('HOSTS') || types.has('RUNS'), `${org.name}: no HOSTS or RUNS link`).toBe(true);
      for (const type of ['EXPOSED_TO', 'MITIGATED_BY', 'GOVERNED_BY', 'IMPACTS', 'EXPOSES']) {
        expect(types.has(type), `${org.name}: no ${type} link`).toBe(true);
      }
      for (const link of s.links) {
        expect([kindOf.get(link.fromId), kindOf.get(link.toId)], `${org.name}: ${link.type}`).toEqual(
          LINK_ENDS[link.type],
        );
      }
    }
  });

  it('a spread of labels: every label from public to restricted among the records, and among the risks', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      expect(new Set(s.records.map((r) => r.label)), `${org.name}: record labels`).toEqual(new Set(LABELS));
      expect(new Set(ofKind(s, 'risk').map((r) => r.label)), `${org.name}: risk labels`).toEqual(new Set(LABELS));
    }
  });

  it('at least 3 controls owned by the demo Control Owner, at a label their internal clearance sees', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const co = await controlOwnerOf(org.id);
      const controls = ofKind(await snapshot(org.id), 'control');
      const own = controls.filter((c) => c.owner === co && (c.label === 'public' || c.label === 'internal'));
      expect(own.length, `${org.name}: controls the Control Owner owns and sees`).toBeGreaterThanOrEqual(3);
      expect(
        controls.some((c) => c.owner !== co),
        `${org.name}: every control is the Control Owner's, so "only their own" doesn't show`,
      ).toBe(true);
    }
  });

  it('every owner is a member of the org', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const members = new Set((await membersOf(e(), org.id)).map((m) => m.userId));
      const s = await snapshot(org.id);
      expect(s.records.length, `${org.name}: no records`).toBeGreaterThan(0);
      for (const r of s.records) expect(members.has(r.owner), `${r.number} owner`).toBe(true);
    }
  });

  it('the two orgs have different data: each has risks the other lacks', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    const a = new Set(ofKind(await snapshot(acme.id), 'risk').map((r) => r.name));
    const g = new Set(ofKind(await snapshot(globex.id), 'risk').map((r) => r.name));
    expect(
      [...a].some((name) => !g.has(name)),
      'every Acme risk name is also a Globex one',
    ).toBe(true);
    expect(
      [...g].some((name) => !a.has(name)),
      'every Globex risk name is also an Acme one',
    ).toBe(true);
  });

  it('every record has a fixed source ID, unique in its org', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      expect(s.records.length, `${org.name}: no records`).toBeGreaterThan(0);
      const all: string[] = [];
      for (const r of s.records) {
        expect(r.sourceIds.length, `${org.name}: ${r.number} has no sourceIds`).toBeGreaterThan(0);
        all.push(...r.sourceIds);
      }
      expect(new Set(all).size, `${org.name}: a source ID is used twice`).toBe(all.length);
    }
  });
});

describe('criterion 3: every demo record and link has its audit entry in Postgres', { timeout: T }, () => {
  it('a record.created entry for every record, with its number in meta', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      expect(s.records.length).toBeGreaterThan(0);
      const created = (await auditRows(org.id)).filter((r) => r.action === 'record.created');
      for (const r of s.records) {
        const entries = created.filter((a) => a.targetId === r.id);
        expect(entries, `${org.name}: ${r.number} record.created entries`).toHaveLength(1);
        expect(entries[0]!.targetType).toBe(r.kind);
        expect(entries[0]!.meta?.['number']).toBe(r.number);
      }
    }
  });

  it('a link.created entry for every link', async () => {
    await seededOnce();
    const { linkTargetId } = await import('../../src/records/links.service.js');
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) {
      const s = await snapshot(org.id);
      expect(s.links.length).toBeGreaterThan(0);
      const created = (await auditRows(org.id)).filter((r) => r.action === 'link.created');
      for (const l of s.links) {
        const target = linkTargetId(l.type, l.fromId, l.toId);
        const entries = created.filter((a) => a.targetId === target);
        expect(entries, `${org.name}: ${l.type} link.created entries`).toHaveLength(1);
        expect(entries[0]!.targetType).toBe('link');
      }
    }
  });

  it("each org's audit chain still verifies", async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    for (const org of [acme, globex]) expect(await e().audit.verifyChain(org.id)).toEqual({ ok: true });
  });
});

describe('criterion 2: running `pnpm seed:demo` again adds nothing', { timeout: T }, () => {
  it('the same records, numbers, versions and links, and no new audit entries', async () => {
    await seededOnce();
    const { acme, globex } = await demoOrgs();
    const before = new Map<string, { snap: Snapshot; audit: number }>();
    for (const org of [acme, globex]) {
      before.set(org.id, { snap: await snapshot(org.id), audit: (await auditRows(org.id)).length });
    }

    const again = await seed();
    expect(again.status, output(again)).toBe(0);
    await relayAll();

    expect((await orgsIn(e())).map((o) => o.id).sort()).toEqual([acme.id, globex.id].sort());
    for (const org of [acme, globex]) {
      const was = before.get(org.id)!;
      expect(was.snap.records.length).toBeGreaterThan(0);
      expect(await snapshot(org.id), `${org.name}: records or links changed`).toEqual(was.snap);
      expect((await auditRows(org.id)).length, `${org.name}: new audit entries`).toBe(was.audit);
    }
  });
});
