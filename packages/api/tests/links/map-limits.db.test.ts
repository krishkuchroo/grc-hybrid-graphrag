// S1-005 criterion 4, the D204 numbers: depth 1, 2 or 3 (2 when none is given), and at most 200
// assets with the centre included, then `truncated: true`. `truncated` is false whenever nothing was
// left out, and the same data gives the same nodes every time (D45.8). The numbers come from
// `@grc/shared` (MAP_DEFAULT_DEPTH, MAP_MAX_DEPTH, MAP_MAX_NODES).
//
// The large stars are written straight into the throwaway org database by the Desktop account
// (bulk test data with every D73 record property); the centres and the chain are made by the app.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  bulkAssets,
  bulkLinks,
  edgeKey,
  edgeKeys,
  getMap,
  linkDirect,
  ids,
  mapBody,
  makeRecord,
  newLinksOrg,
  person,
  setUpLinks,
  tearDownLinks,
  type Label,
  type LinksEnv,
  type MapBody,
  type Person,
  type Rec,
} from './helpers.js';

let env: LinksEnv;
let admin: Person;
let viewerInternal: Person;
let orgId: string;

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links Map Limits');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  viewerInternal = await person(env, org, 'viewer', 'internal');
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

async function asset(label: Label = 'internal'): Promise<Rec> {
  return makeRecord(env, admin, 'asset', { label });
}

// Set-up links are written straight into the org database, shaped like manual links (S1 shared
// notes), so this file's set-up never depends on POST /api/v1/links (create.db.test.ts covers it).
async function link(type: string, from: Rec, to: Rec): Promise<void> {
  await linkDirect(env, admin.org.id, type, from.id, to.id, admin.id);
}

/** Every node can be reached from the centre through the returned edges, in either direction. */
function expectConnected(body: MapBody, centreId: string): void {
  const next = new Map<string, string[]>();
  for (const e of body.edges) {
    next.set(e.fromId, [...(next.get(e.fromId) ?? []), e.toId]);
    next.set(e.toId, [...(next.get(e.toId) ?? []), e.fromId]);
  }
  const seen = new Set([centreId]);
  const queue = [centreId];
  while (queue.length > 0) {
    for (const n of next.get(queue.shift()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  expect([...seen].sort()).toEqual(ids(body.nodes));
}

function expectEdgesWithinNodes(body: MapBody): void {
  const nodeIds = new Set(body.nodes.map((n) => n.id));
  for (const e of body.edges) {
    expect(nodeIds.has(e.fromId) && nodeIds.has(e.toId), `edge ${e.fromId} ${e.type} ${e.toId}`).toBe(true);
  }
}

function expectNoDuplicates(body: MapBody): void {
  expect(new Set(body.nodes.map((n) => n.id)).size).toBe(body.nodes.length);
  expect(new Set(edgeKeys(body.edges)).size).toBe(body.edges.length);
}

describe('D204: depth 1 to 3, 2 when none is given', () => {
  // x4 <-HOSTS- x3 <-HOSTS- x2 <-RUNS- x1 <-HOSTS- centre <-RUNS- y1 <-HOSTS- y2 <-RUNS- y3
  let centre: Rec;
  let x: Rec[];
  let y: Rec[];

  beforeAll(async () => {
    centre = await asset();
    x = [await asset(), await asset(), await asset(), await asset()];
    y = [await asset(), await asset(), await asset()];
    await link('HOSTS', centre, x[0]!);
    await link('RUNS', x[0]!, x[1]!);
    await link('HOSTS', x[1]!, x[2]!);
    await link('HOSTS', x[2]!, x[3]!);
    await link('RUNS', y[0]!, centre);
    await link('HOSTS', y[1]!, y[0]!);
    await link('RUNS', y[2]!, y[1]!);
  }, LONG);

  function expected(depth: number): { nodes: string[]; edges: string[] } {
    const nodes = [centre, ...x.slice(0, depth), ...y.slice(0, depth)];
    const allEdges = [
      [1, edgeKey(centre, 'HOSTS', x[0]!)],
      [2, edgeKey(x[0]!, 'RUNS', x[1]!)],
      [3, edgeKey(x[1]!, 'HOSTS', x[2]!)],
      [1, edgeKey(y[0]!, 'RUNS', centre)],
      [2, edgeKey(y[1]!, 'HOSTS', y[0]!)],
      [3, edgeKey(y[2]!, 'RUNS', y[1]!)],
    ] as const;
    return {
      nodes: ids(nodes),
      edges: allEdges
        .filter(([d]) => d <= depth)
        .map(([, k]) => k)
        .sort(),
    };
  }

  it.each([1, 2, 3])(
    'depth %d reaches exactly that many steps out, both ways',
    async (depth) => {
      const body = mapBody(await getMap(env, admin, centre.id, depth));
      const want = expected(depth);
      expect(ids(body.nodes)).toEqual(want.nodes);
      expect(edgeKeys(body.edges)).toEqual(want.edges);
      expect(body.truncated, 'nothing was left out by the cap').toBe(false);
    },
    T,
  );

  it(
    'no depth given is depth 2',
    async () => {
      const body = mapBody(await getMap(env, admin, centre.id));
      const want = expected(2);
      expect(ids(body.nodes)).toEqual(want.nodes);
      expect(edgeKeys(body.edges)).toEqual(want.edges);
      expect(body.truncated).toBe(false);
    },
    T,
  );

  it(
    'the fourth step out is never reached',
    async () => {
      const body = mapBody(await getMap(env, admin, centre.id, 3));
      expect(ids(body.nodes)).not.toContain(x[3]!.id);
    },
    T,
  );

  it(
    'a diamond and a loop give each asset and each edge once',
    async () => {
      const c = await asset();
      const d1 = await asset();
      const d2 = await asset();
      const e = await asset();
      await link('HOSTS', c, d1);
      await link('HOSTS', c, d2);
      await link('RUNS', d1, e);
      await link('RUNS', d2, e);
      await link('HOSTS', e, c); // back to the centre
      const body = mapBody(await getMap(env, admin, c.id, 3));
      expectNoDuplicates(body);
      expect(ids(body.nodes)).toEqual(ids([c, d1, d2, e]));
      expect(edgeKeys(body.edges)).toEqual(
        [
          edgeKey(c, 'HOSTS', d1),
          edgeKey(c, 'HOSTS', d2),
          edgeKey(d1, 'RUNS', e),
          edgeKey(d2, 'RUNS', e),
          edgeKey(e, 'HOSTS', c),
        ].sort(),
      );
      expect(body.truncated).toBe(false);
    },
    T,
  );
});

describe('D204: at most 200 assets, the centre included', () => {
  it(
    'exactly 200 assets in reach (the centre and 199): all of them, truncated false',
    async () => {
      const centre = await asset();
      const leaves = await bulkAssets(env, orgId, 199, { owner: admin.id, numberPrefix: 10 });
      await bulkLinks(env, orgId, 'HOSTS', centre.id, leaves);
      const body = mapBody(await getMap(env, admin, centre.id, 1));
      expect(body.nodes).toHaveLength(200);
      expect(ids(body.nodes)).toEqual([centre.id, ...leaves].sort());
      expect(body.edges).toHaveLength(199);
      expect(body.truncated).toBe(false);
    },
    LONG,
  );

  it(
    'a star of 250 around the centre: exactly 200 assets, truncated true, the centre included',
    async () => {
      const centre = await asset();
      const leaves = await bulkAssets(env, orgId, 250, { owner: admin.id, numberPrefix: 11 });
      await bulkLinks(env, orgId, 'RUNS', centre.id, leaves);
      const body = mapBody(await getMap(env, admin, centre.id));
      expect(body.nodes).toHaveLength(200);
      expect(body.truncated).toBe(true);
      expect(ids(body.nodes)).toContain(centre.id);
      expectNoDuplicates(body);
      expectEdgesWithinNodes(body);
      expectConnected(body, centre.id);
    },
    LONG,
  );

  it(
    'the same data gives the same nodes every time (D45.8)',
    async () => {
      const centre = await asset();
      const leaves = await bulkAssets(env, orgId, 230, { owner: admin.id, numberPrefix: 12 });
      await bulkLinks(env, orgId, 'HOSTS', centre.id, leaves);
      const first = mapBody(await getMap(env, admin, centre.id, 2));
      const second = mapBody(await getMap(env, admin, centre.id, 2));
      const third = mapBody(await getMap(env, admin, centre.id, 2));
      expect(first.nodes).toHaveLength(200);
      expect(ids(second.nodes)).toEqual(ids(first.nodes));
      expect(ids(third.nodes)).toEqual(ids(first.nodes));
      expect(edgeKeys(second.edges)).toEqual(edgeKeys(first.edges));
    },
    LONG,
  );

  it(
    'cut short two steps out: the centre and the hub it hosts stay, 200 assets in all',
    async () => {
      const centre = await asset();
      const hub = await asset();
      await link('HOSTS', centre, hub);
      const leaves = await bulkAssets(env, orgId, 250, { owner: admin.id, numberPrefix: 13 });
      await bulkLinks(env, orgId, 'HOSTS', hub.id, leaves);

      const one = mapBody(await getMap(env, admin, centre.id, 1));
      expect(ids(one.nodes)).toEqual(ids([centre, hub]));
      expect(one.truncated).toBe(false);

      const two = mapBody(await getMap(env, admin, centre.id, 2));
      expect(two.nodes).toHaveLength(200);
      expect(two.truncated).toBe(true);
      expect(ids(two.nodes)).toContain(centre.id);
      expect(ids(two.nodes)).toContain(hub.id);
      expectEdgesWithinNodes(two);
      expectConnected(two, centre.id);
    },
    LONG,
  );

  it(
    'hidden assets do not count: 150 visible of 260 in reach is all 150, truncated false',
    async () => {
      const centre = await asset('internal');
      const shown = await bulkAssets(env, orgId, 149, { owner: admin.id, numberPrefix: 14, label: 'internal' });
      const hidden = await bulkAssets(env, orgId, 110, { owner: admin.id, numberPrefix: 15, label: 'restricted' });
      await bulkLinks(env, orgId, 'HOSTS', centre.id, [...shown, ...hidden]);
      const res = await getMap(env, viewerInternal, centre.id, 1);
      const body = mapBody(res);
      expect(ids(body.nodes)).toEqual([centre.id, ...shown].sort());
      expect(body.truncated).toBe(false);
      for (const id of hidden) expect(res.body).not.toContain(id);
    },
    LONG,
  );
});
