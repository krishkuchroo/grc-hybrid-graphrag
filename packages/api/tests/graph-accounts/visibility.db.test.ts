// M0-005 criteria 3, 4 and 5, for all 28 accounts in two org databases.
// Decisions: D22 (one database per org), D23, D50 (role × record type), D51 (clearance vs
// label; a link is visible only if both ends are), D52.1 (the AI sees only what the user can
// see), D59 (every clearance × label pair), D73 (the audit outbox is hidden from query accounts).
//
// Fixtures (helpers.ts): in each of two throwaway org databases, one node per type (Asset, Risk,
// Control, Policy, Incident, Framework, Requirement, Evidence, AuditFinding) × label (public,
// internal, confidential, restricted) in the `sensitivity` property; a CONCERNS link between
// every ordered pair; AuditOutbox entries (one per label and one without) linked to an Asset.
//
// What must hold, per account `grc_ro_<role>_<clearance>`:
// - Criterion 3: a type whose D50 cell is `—` is invisible (e.g. Incident for control_owner and
//   viewer; Evidence and AuditFinding for viewer). Every other type the role views is visible.
//   Cells that depend on ownership (`edit_own`, `upload_own`) are left open here: a shared
//   account can't know the owner, so the tests don't assert either way on those nodes.
// - Criterion 4: a node whose `sensitivity` is above the clearance is invisible, and so is every
//   link that touches it (or a type-hidden node). Visible nodes and links are readable (their
//   `id` comes back, not null).
// - Criterion 5: AuditOutbox nodes, and their links, are invisible to all 28.
// - Only the asked-for org's data comes back (org-A's ids only when reading org-A).
//
// Checked twice: through `GraphService.readAs`, and straight to Neo4j as the account
// (impersonation), so the rule lives in the database and not only in our code (principle 3).
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  ThrowawayDatabases,
  expectedNodes,
  expectedRels,
  fixtureNodeId,
  impersonatedRunner,
  keepAsserted,
  newGraph,
  readAsRunner,
  runOn,
  runSetupNeo4j,
  superDriver,
  visibleNodeIds,
  visibleRelIds,
  type Account,
  type FixtureOrg,
  type QueryGraph,
  type Runner,
} from './helpers.js';

let sup: Driver;
let databases: ThrowawayDatabases;
let graph: QueryGraph | undefined;
let orgA: FixtureOrg;
let orgB: FixtureOrg;

beforeAll(async () => {
  sup = superDriver();
  databases = new ThrowawayDatabases(sup);
  runSetupNeo4j();
  orgA = await createFixtureOrg(sup, databases);
  orgB = await createFixtureOrg(sup, databases);
  try {
    graph = newGraph();
  } catch {
    graph = undefined;
  }
}, LONG);

afterAll(async () => {
  try {
    await graph?.close();
    if (databases) await databases.dropAll();
  } finally {
    await sup?.close();
  }
}, LONG);

describe('fixtures', () => {
  it('hold every type × label, every ordered pair link and the outbox, in both orgs', async () => {
    for (const org of [orgA, orgB]) {
      const [row] = await runOn(
        sup,
        org.database,
        `CALL () { MATCH (n {fixture: true}) RETURN count(n) AS nodes }
         CALL () { MATCH ({fixture: true})-[r]->({fixture: true}) RETURN count(r) AS rels }
         CALL () { MATCH (o:AuditOutbox) RETURN count(o) AS outbox }
         RETURN nodes, rels, outbox`,
      );
      expect(row).toEqual({ nodes: 36, rels: 36 * 35, outbox: 5 });
    }
  });
});

const ways: [string, (a: Account) => Runner][] = [
  ['GraphService.readAs', (a) => readAsRunner(graph, a)],
  ['Neo4j as the account', (a) => impersonatedRunner(sup, a)],
];

describe.each(ways)('through %s', (_way, runnerFor) => {
  describe.each(ACCOUNTS)('$name', (account) => {
    it('sees exactly the nodes its role and clearance allow, in the asked-for org only (criteria 3, 4)', async () => {
      const run = runnerFor(account);
      for (const [org, other] of [
        [orgA, orgB],
        [orgB, orgA],
      ] as const) {
        const { decided, visible } = expectedNodes(account, org);
        const undecided = (id: string): boolean => org.nodes.some((n) => n.id === id) && !decided.has(id);
        const seen = keepAsserted(await visibleNodeIds(run, org), org, undecided);
        expect(seen, `${account.name} in ${org.database}`).toEqual(visible);
        expect(seen.some((id) => id.startsWith(`${other.orgId}:`))).toBe(false);
      }
    });

    it('sees a link only when both ends are visible (criterion 4, D51)', async () => {
      const run = runnerFor(account);
      for (const org of [orgA, orgB]) {
        const { decided, visible } = expectedRels(account, org);
        const undecided = (id: string): boolean => id.includes('->') && !id.includes(':outbox:') && !decided.has(id);
        const seen = keepAsserted(await visibleRelIds(run, org), org, undecided);
        expect(seen, `${account.name} in ${org.database}`).toEqual(visible);
      }
    });

    it('cannot reach a hidden node by its id or through a link (criteria 3, 4)', async () => {
      const run = runnerFor(account);
      // Every role views frameworks (D50) and every clearance covers public: this one is reachable.
      const reachable = fixtureNodeId(orgA.orgId, 'Framework', 'public');
      const sanity = await run(orgA, `MATCH (n {id: '${reachable}'}) RETURN n.id AS id`);
      expect(
        sanity.map((r) => r['id']),
        'a visible node must be reachable by id',
      ).toEqual([reachable]);
      const hidden = orgA.nodes.filter((n) => !expectedNodes(account, orgA).visible.includes(n.id));
      const decidedHidden = hidden.filter((n) => expectedNodes(account, orgA).decided.has(n.id));
      for (const node of decidedHidden) {
        const direct = await run(orgA, `MATCH (n {id: '${node.id}'}) RETURN n.id AS id`);
        expect(direct, `${node.id} by id`).toEqual([]);
        const viaLink = await run(orgA, `MATCH ()-[]-(n) WHERE n.id = '${node.id}' RETURN n.id AS id`);
        expect(viaLink, `${node.id} through a link`).toEqual([]);
      }
    });

    it('never sees an AuditOutbox node or its links (criterion 5, D73)', async () => {
      const run = runnerFor(account);
      for (const org of [orgA, orgB]) {
        expect(await run(org, 'MATCH (o:AuditOutbox) RETURN o.id AS id')).toEqual([]);
        const all = (await visibleNodeIds(run, org)).map(String);
        expect(all.filter((id) => id.includes(':outbox:'))).toEqual([]);
        const rels = (await visibleRelIds(run, org)).map(String);
        expect(rels.filter((id) => id.includes(':outbox:'))).toEqual([]);
        const labels = await run(org, 'MATCH (n) UNWIND labels(n) AS l RETURN DISTINCT l AS label');
        expect(labels.map((r) => r['label'])).not.toContain('AuditOutbox');
      }
    });
  });
});

describe('the D50 `—` cells named in the brief (criterion 3)', () => {
  const byName = (name: string): Account => ACCOUNTS.find((a) => a.name === name)!;

  it.each(['grc_ro_control_owner_restricted', 'grc_ro_viewer_restricted'])(
    '%s sees no Incident, even at the top clearance',
    async (name) => {
      const run = readAsRunner(graph, byName(name));
      expect(await run(orgA, 'MATCH (i:Incident) RETURN i.id AS id')).toEqual([]);
    },
  );

  it('grc_ro_admin_restricted sees every Incident', async () => {
    const run = readAsRunner(graph, byName('grc_ro_admin_restricted'));
    const rows = await run(orgA, 'MATCH (i:Incident) RETURN i.id AS id ORDER BY id');
    expect(rows.map((r) => r['id'])).toEqual(
      ['confidential', 'internal', 'public', 'restricted'].map((l) =>
        fixtureNodeId(orgA.orgId, 'Incident', l as 'public'),
      ),
    );
  });

  it('grc_ro_admin_internal sees public and internal Assets only (criterion 4)', async () => {
    const run = readAsRunner(graph, byName('grc_ro_admin_internal'));
    const rows = await run(orgA, 'MATCH (a:Asset) RETURN a.id AS id ORDER BY id');
    expect(rows.map((r) => r['id'])).toEqual([
      fixtureNodeId(orgA.orgId, 'Asset', 'internal'),
      fixtureNodeId(orgA.orgId, 'Asset', 'public'),
    ]);
  });
});
