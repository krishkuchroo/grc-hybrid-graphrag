// S1-005 criterion 3: listing a record's links, GET /api/v1/<plural>/:id/links (D51, D45.3, D50,
// D199, D206).
// - The answer is `{ items: [{ type, direction, other: { id, kind, number, name, label, status },
//   origin, createdAt, createdBy }] }`; `direction` is 'out' when the record is the link's from end.
// - It runs through `readAs` (the caller's role x clearance account), so a link with a hidden end is
//   never returned, not even as a count.
// - The Control Owner path applies ownership and label to both ends.
// - The record itself not visible is 404, the same as one that doesn't exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  appGraph,
  getLinks,
  json,
  linkDirect,
  linkItems,
  makeRecord,
  newLinksOrg,
  person,
  refusal,
  setUpLinks,
  show,
  tearDownLinks,
  type Label,
  type LinkItem,
  type LinksEnv,
  type Person,
  type Rec,
} from './helpers.js';

let env: LinksEnv;
let admin: Person;
let viewerInternal: Person;
let controlOwner: Person;
let orgId: string;

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links List');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  viewerInternal = await person(env, org, 'viewer', 'internal');
  controlOwner = await person(env, org, 'control_owner', 'internal');
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

async function rec(kind: Rec['kind'], label: Label = 'internal', owner?: string): Promise<Rec> {
  return makeRecord(env, admin, kind, { label, ...(owner !== undefined ? { owner } : {}) });
}

// Set-up links are written straight into the org database, shaped like manual links (S1 shared
// notes), so this file's set-up never depends on POST /api/v1/links (create.db.test.ts covers it).
async function link(type: string, from: Rec, to: Rec): Promise<void> {
  await linkDirect(env, admin.org.id, type, from.id, to.id, admin.id);
}

function byOther(items: LinkItem[]): Map<string, LinkItem> {
  return new Map(items.map((i) => [i.other.id, i]));
}

describe("criterion 3: the shape of a record's links", () => {
  it(
    "a risk's links, out and in, with the other end's summary and the link's origin",
    async () => {
      const risk = await rec('risk');
      const control = await rec('control', 'public');
      const asset = await rec('asset');
      const incident = await rec('incident', 'confidential');
      await link('MITIGATED_BY', risk, control);
      await link('EXPOSED_TO', asset, risk);
      await link('EXPOSES', incident, risk);

      const items = linkItems(await getLinks(env, admin, 'risk', risk.id));
      expect(items).toHaveLength(3);
      const found = byOther(items);

      expect(found.get(control.id)).toMatchObject({
        type: 'MITIGATED_BY',
        direction: 'out',
        other: {
          id: control.id,
          kind: 'control',
          number: control.number,
          name: control.name,
          label: 'public',
          status: 'active',
        },
        origin: 'manual',
        createdBy: admin.id,
      });
      expect(found.get(asset.id)).toMatchObject({
        type: 'EXPOSED_TO',
        direction: 'in',
        other: { id: asset.id, kind: 'asset', number: asset.number, name: asset.name, label: 'internal' },
        origin: 'manual',
      });
      expect(found.get(incident.id)).toMatchObject({
        type: 'EXPOSES',
        direction: 'in',
        other: { id: incident.id, kind: 'incident', number: incident.number, label: 'confidential' },
      });
      for (const item of items) {
        expect(Number.isNaN(Date.parse(item.createdAt)), `createdAt: ${item.createdAt}`).toBe(false);
      }
    },
    T,
  );

  it(
    "origin is the link's stored origin (an import link says import)",
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      await linkDirect(env, orgId, 'RUNS', a.id, b.id, admin.id);
      const { runOn } = await import('../graph/helpers.js');
      await runOn(env.sup, `org-${orgId}`, "MATCH ({id: $a})-[r:RUNS]->({id: $b}) SET r.origin = 'import'", {
        a: a.id,
        b: b.id,
      });
      const items = linkItems(await getLinks(env, admin, 'asset', a.id));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: 'RUNS', direction: 'out', origin: 'import' });
    },
    T,
  );

  it(
    'a record with no links answers an empty list',
    async () => {
      const policy = await rec('policy');
      expect(linkItems(await getLinks(env, admin, 'policy', policy.id))).toEqual([]);
    },
    T,
  );
});

describe('criterion 3: a link with a hidden end is never returned', () => {
  it(
    'a Viewer (clearance internal) sees only the links whose other end they can see',
    async () => {
      const risk = await rec('risk', 'internal');
      const shown = await rec('control', 'internal');
      const hiddenByLabel = await rec('control', 'confidential');
      const hiddenByType = await rec('incident', 'public');
      await link('MITIGATED_BY', risk, shown);
      await link('MITIGATED_BY', risk, hiddenByLabel);
      await link('EXPOSES', hiddenByType, risk);

      const res = await getLinks(env, viewerInternal, 'risk', risk.id);
      const items = linkItems(res);
      expect(items.map((i) => i.other.id)).toEqual([shown.id]);
      // Not even as a count, and nothing about the hidden records anywhere in the answer.
      const body = json(res);
      if ('total' in body) expect(body['total']).toBe(1);
      for (const hidden of [hiddenByLabel, hiddenByType]) {
        expect(res.body).not.toContain(hidden.id);
        expect(res.body).not.toContain(hidden.number);
        expect(res.body).not.toContain(hidden.name);
      }
    },
    T,
  );

  it(
    "the read runs as the caller's read-only account (readAs, with the caller's role and clearance)",
    async () => {
      const risk = await rec('risk', 'internal');
      const graph = await appGraph(env);
      const real = graph.readAs;
      const seen: string[] = [];
      graph.readAs = function (this: unknown, ...args: unknown[]) {
        seen.push(`${String(args[1])}/${String(args[2])}`);
        return real.apply(this, args);
      };
      try {
        const res = await getLinks(env, viewerInternal, 'risk', risk.id);
        expect(res.statusCode, show(res)).toBe(200);
      } finally {
        graph.readAs = real;
      }
      expect(seen).toContain('viewer/internal');
    },
    T,
  );
});

describe('criterion 3: the record itself not visible is 404', () => {
  it(
    "a record above the caller's clearance: 404, the same as a made-up ID",
    async () => {
      const hidden = await rec('risk', 'confidential');
      const ghost = refusal(await getLinks(env, viewerInternal, 'risk', '00000000-0000-4000-8000-00000000000a'), 404);
      const above = refusal(await getLinks(env, viewerInternal, 'risk', hidden.id), 404);
      expect(ghost.code).toBe('not_found');
      expect(above).toEqual(ghost);
    },
    T,
  );

  it(
    "a record's ID under another kind's path: 404 (a risk ID on /controls/:id/links)",
    async () => {
      const risk = await rec('risk');
      refusal(await getLinks(env, admin, 'control', risk.id), 404);
    },
    T,
  );
});

describe('criterion 3: the Control Owner path applies ownership and label to both ends', () => {
  let policy: Rec;
  let risk: Rec;
  let own: Rec;
  let ownConfidential: Rec;
  let notOwn: Rec;

  beforeAll(async () => {
    policy = await rec('policy', 'internal');
    risk = await rec('risk', 'internal');
    own = await rec('control', 'internal', controlOwner.id);
    ownConfidential = await rec('control', 'confidential', controlOwner.id);
    notOwn = await rec('control', 'internal', admin.id);
    for (const c of [own, ownConfidential, notOwn]) {
      await link('GOVERNED_BY', c, policy);
      await link('MITIGATED_BY', risk, c);
    }
  }, LONG);

  it(
    'on a policy: only their own control within their clearance shows',
    async () => {
      const res = await getLinks(env, controlOwner, 'policy', policy.id);
      expect(linkItems(res).map((i) => i.other.id)).toEqual([own.id]);
      expect(res.body).not.toContain(notOwn.id);
      expect(res.body).not.toContain(ownConfidential.id);
    },
    T,
  );

  it(
    'on a risk: the same',
    async () => {
      const res = await getLinks(env, controlOwner, 'risk', risk.id);
      expect(linkItems(res).map((i) => i.other.id)).toEqual([own.id]);
    },
    T,
  );

  it(
    'on their own control: its links to the policy and the risk',
    async () => {
      const items = linkItems(await getLinks(env, controlOwner, 'control', own.id));
      expect(items.map((i) => `${i.type} ${i.direction} ${i.other.id}`).sort()).toEqual(
        [`GOVERNED_BY out ${policy.id}`, `MITIGATED_BY in ${risk.id}`].sort(),
      );
    },
    T,
  );

  it(
    "on someone else's control: 404",
    async () => {
      refusal(await getLinks(env, controlOwner, 'control', notOwn.id), 404);
    },
    T,
  );

  it(
    'on their own control above their clearance: 404',
    async () => {
      refusal(await getLinks(env, controlOwner, 'control', ownConfidential.id), 404);
    },
    T,
  );
});
