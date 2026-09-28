// S1-005 criterion 4: the asset map, GET /api/v1/assets/:id/map (D204, D51, D45.3).
// - It follows only HOSTS and RUNS, in both directions, from the given asset.
// - It returns only visible assets, and only edges between them. A visible asset reached only
//   through a hidden one is not reached: the hidden asset never reaches the caller (D51).
// - A depth of 0, 4, a fraction or text is 400. The centre not visible, not an asset, or made up is
//   404.
// The depth numbers and the 200-asset cap are in map-limits.db.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  appGraph,
  edgeKey,
  edgeKeys,
  getMap,
  linkDirect,
  ids,
  mapBody,
  makeRecord,
  newLinksOrg,
  person,
  refusal,
  setUpLinks,
  show,
  tearDownLinks,
  type Label,
  type LinksEnv,
  type Person,
  type Rec,
} from './helpers.js';

let env: LinksEnv;
let admin: Person;
let viewerInternal: Person;

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links Map');
  admin = await person(env, org, 'admin', 'restricted');
  viewerInternal = await person(env, org, 'viewer', 'internal');
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

async function rec(kind: Rec['kind'], label: Label = 'internal'): Promise<Rec> {
  return makeRecord(env, admin, kind, { label });
}

// Set-up links are written straight into the org database, shaped like manual links (S1 shared
// notes), so this file's set-up never depends on POST /api/v1/links (create.db.test.ts covers it).
async function link(type: string, from: Rec, to: Rec): Promise<void> {
  await linkDirect(env, admin.org.id, type, from.id, to.id, admin.id);
}

describe('criterion 4: HOSTS and RUNS only, both directions', () => {
  let centre: Rec;
  let hosted: Rec;
  let runsCentre: Rec;
  let viaIncident: Rec;
  let risk: Rec;

  beforeAll(async () => {
    centre = await rec('asset');
    hosted = await rec('asset');
    runsCentre = await rec('asset');
    viaIncident = await rec('asset');
    risk = await rec('risk');
    const incident = await rec('incident');
    await link('HOSTS', centre, hosted); // out
    await link('RUNS', runsCentre, centre); // in
    await link('EXPOSED_TO', centre, risk); // not followed
    await link('IMPACTS', incident, centre); // not followed
    await link('IMPACTS', incident, viaIncident); // so this asset is never on the map
  }, LONG);

  it(
    'the centre, what it hosts and what runs it, with only their HOSTS and RUNS edges',
    async () => {
      for (const depth of [1, 2, 3]) {
        const body = mapBody(await getMap(env, admin, centre.id, depth));
        expect(ids(body.nodes), `depth ${depth}`).toEqual(ids([centre, hosted, runsCentre]));
        expect(edgeKeys(body.edges), `depth ${depth}`).toEqual(
          [edgeKey(centre, 'HOSTS', hosted), edgeKey(runsCentre, 'RUNS', centre)].sort(),
        );
        expect(body.truncated).toBe(false);
      }
    },
    T,
  );

  it(
    'never a risk, an incident, or an asset reached only through one',
    async () => {
      const res = await getMap(env, admin, centre.id, 3);
      const body = mapBody(res);
      expect(ids(body.nodes)).not.toContain(viaIncident.id);
      expect(ids(body.nodes)).not.toContain(risk.id);
      for (const e of body.edges) expect(['HOSTS', 'RUNS']).toContain(e.type);
    },
    T,
  );

  it(
    'each node carries id, number, name, assetType, criticality and label',
    async () => {
      const body = mapBody(await getMap(env, admin, centre.id));
      const node = body.nodes.find((n) => n.id === hosted.id);
      expect(node).toEqual({
        id: hosted.id,
        number: hosted.number,
        name: hosted.name,
        assetType: hosted['assetType'],
        criticality: hosted['criticality'],
        label: hosted.label,
      });
    },
    T,
  );

  it(
    'opened from the other end, the same edge is followed backwards',
    async () => {
      const body = mapBody(await getMap(env, admin, hosted.id, 1));
      expect(ids(body.nodes)).toEqual(ids([hosted, centre]));
      expect(edgeKeys(body.edges)).toEqual([edgeKey(centre, 'HOSTS', hosted)]);
    },
    T,
  );
});

describe('criterion 4: only visible assets and edges between them', () => {
  let centre: Rec;
  let shown: Rec;
  let hidden: Rec;
  let beyondHidden: Rec;

  beforeAll(async () => {
    centre = await rec('asset', 'internal');
    shown = await rec('asset', 'public');
    hidden = await rec('asset', 'restricted');
    beyondHidden = await rec('asset', 'public');
    await link('HOSTS', centre, shown);
    await link('HOSTS', centre, hidden);
    await link('RUNS', hidden, beyondHidden);
  }, LONG);

  it(
    'a Viewer with clearance internal sees neither the restricted asset nor what lies only behind it',
    async () => {
      const res = await getMap(env, viewerInternal, centre.id, 3);
      const body = mapBody(res);
      expect(ids(body.nodes)).toEqual(ids([centre, shown]));
      expect(edgeKeys(body.edges)).toEqual([edgeKey(centre, 'HOSTS', shown)]);
      expect(res.body).not.toContain(hidden.id);
      expect(res.body).not.toContain(hidden.number);
      expect(res.body).not.toContain(beyondHidden.id);
    },
    T,
  );

  it(
    'an Admin with clearance restricted sees all four',
    async () => {
      const body = mapBody(await getMap(env, admin, centre.id, 3));
      expect(ids(body.nodes)).toEqual(ids([centre, shown, hidden, beyondHidden]));
      expect(edgeKeys(body.edges)).toEqual(
        [
          edgeKey(centre, 'HOSTS', shown),
          edgeKey(centre, 'HOSTS', hidden),
          edgeKey(hidden, 'RUNS', beyondHidden),
        ].sort(),
      );
    },
    T,
  );

  it(
    "the map reads as the caller's read-only account (readAs, with the caller's role and clearance)",
    async () => {
      const graph = await appGraph(env);
      const real = graph.readAs;
      const seen: string[] = [];
      graph.readAs = function (this: unknown, ...args: unknown[]) {
        seen.push(`${String(args[1])}/${String(args[2])}`);
        return real.apply(this, args);
      };
      try {
        const res = await getMap(env, viewerInternal, centre.id);
        expect(res.statusCode, show(res)).toBe(200);
      } finally {
        graph.readAs = real;
      }
      expect(seen).toContain('viewer/internal');
    },
    T,
  );
});

describe('criterion 4: the centre must be a visible asset', () => {
  it(
    "a made-up ID, a risk's ID and an asset above the clearance are all 404, the same answer",
    async () => {
      const risk = await rec('risk', 'public');
      const above = await rec('asset', 'confidential');
      const ghost = refusal(await getMap(env, viewerInternal, '00000000-0000-4000-8000-0000000000b1'), 404);
      expect(ghost.code).toBe('not_found');
      expect(refusal(await getMap(env, viewerInternal, risk.id), 404)).toEqual(ghost);
      expect(refusal(await getMap(env, viewerInternal, above.id), 404)).toEqual(ghost);
    },
    T,
  );
});

describe('criterion 4: a depth of 0, 4, a fraction or text is 400', () => {
  let centre: Rec;

  beforeAll(async () => {
    centre = await rec('asset');
  }, LONG);

  it.each(['0', '4', '1.5', '2.0001', 'two', '-1', '1e0x', '3abc', '99999999999999999999'])(
    'depth=%j',
    async (depth) => {
      refusal(await getMap(env, admin, centre.id, depth), 400);
    },
    T,
  );

  it.each(['1', '2', '3'])(
    'depth=%s is accepted',
    async (depth) => {
      const res = await getMap(env, admin, centre.id, depth);
      expect(res.statusCode, show(res)).toBe(200);
    },
    T,
  );
});
