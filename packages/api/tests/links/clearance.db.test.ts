// S1-005 criterion 5, every clearance x label pair on list and map (D59, D51): 4 clearances x 4
// labels, for an Admin and a Viewer (two different read-only account families). A link between a
// visible and a hidden record is invisible to the lower-clearance user, and a hidden record's own
// links and map are 404. The expectation is worked out from LABELS' order, not through isVisible.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LABELS,
  LONG,
  T,
  edgeKey,
  edgeKeys,
  getLinks,
  getMap,
  linkDirect,
  ids,
  labelRank,
  linkItems,
  mapBody,
  makeRecord,
  newLinksOrg,
  person,
  refusal,
  setUpLinks,
  tearDownLinks,
  type Label,
  type LinksEnv,
  type Person,
  type Rec,
  type Role,
} from './helpers.js';

const ROLES_HERE: Role[] = ['admin', 'viewer'];

let env: LinksEnv;
let creator: Person;
const people = new Map<string, Person>();

// The public centres, and one record per label linked to them.
let riskCentre: Rec;
let assetCentre: Rec;
const controlByLabel = {} as Record<Label, Rec>;
const riskByLabel = {} as Record<Label, Rec>;
const assetByLabel = {} as Record<Label, Rec>;

// Set-up links are written straight into the org database, shaped like manual links (S1 shared
// notes), so the set-up never depends on POST /api/v1/links (create.db.test.ts covers it).
async function link(type: string, from: Rec, to: Rec): Promise<void> {
  await linkDirect(env, creator.org.id, type, from.id, to.id, creator.id);
}

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links Clearance');
  creator = await person(env, org, 'admin', 'restricted');
  for (const role of ROLES_HERE) {
    for (const clearance of LABELS) people.set(`${role}/${clearance}`, await person(env, org, role, clearance));
  }
  riskCentre = await makeRecord(env, creator, 'risk', { label: 'public' });
  assetCentre = await makeRecord(env, creator, 'asset', { label: 'public' });
  for (const label of LABELS) {
    controlByLabel[label] = await makeRecord(env, creator, 'control', { label });
    riskByLabel[label] = await makeRecord(env, creator, 'risk', { label });
    assetByLabel[label] = await makeRecord(env, creator, 'asset', { label });
    await link('MITIGATED_BY', riskCentre, controlByLabel[label]);
    await link('HOSTS', assetCentre, assetByLabel[label]);
    // Each labelled risk has one link of its own, from the public asset centre.
    await link('EXPOSED_TO', assetCentre, riskByLabel[label]);
  }
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

function sees(clearance: Label, label: Label): boolean {
  return labelRank(clearance) >= labelRank(label);
}

const COMBOS = ROLES_HERE.flatMap((role) =>
  LABELS.flatMap((clearance) => LABELS.map((label) => [role, clearance, label] as const)),
);

describe('criterion 5: every clearance x label on the links list', () => {
  it(`covers 2 roles x 4 clearances x 4 labels (${COMBOS.length})`, () => {
    expect(COMBOS).toHaveLength(32);
  });

  it.each(COMBOS)(
    '%s with clearance %s, the other end labelled %s: the link is listed only if they can see it',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const res = await getLinks(env, who, 'risk', riskCentre.id);
      const listed = linkItems(res)
        .filter((i) => i.type === 'MITIGATED_BY')
        .map((i) => i.other.id);
      const target = controlByLabel[label];
      if (sees(clearance, label)) expect(listed).toContain(target.id);
      else {
        expect(listed).not.toContain(target.id);
        expect(res.body).not.toContain(target.id);
        expect(res.body).not.toContain(target.number);
      }
    },
    T,
  );

  it.each(COMBOS)(
    '%s with clearance %s, the record itself labelled %s: its links are 200 or 404',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const res = await getLinks(env, who, 'risk', riskByLabel[label].id);
      if (sees(clearance, label)) {
        expect(linkItems(res).map((i) => i.other.id)).toEqual([assetCentre.id]);
      } else {
        expect(refusal(res, 404).code).toBe('not_found');
      }
    },
    T,
  );

  it.each(ROLES_HERE.flatMap((role) => LABELS.map((clearance) => [role, clearance] as const)))(
    '%s with clearance %s gets exactly the links they may see, nothing more',
    async (role, clearance) => {
      const who = people.get(`${role}/${clearance}`)!;
      const listed = linkItems(await getLinks(env, who, 'risk', riskCentre.id))
        .map((i) => i.other.id)
        .sort();
      const want = LABELS.filter((l) => sees(clearance, l))
        .map((l) => controlByLabel[l].id)
        .sort();
      expect(listed).toEqual(want);
    },
    T,
  );
});

describe('criterion 5: every clearance x label on the map', () => {
  it.each(COMBOS)(
    '%s with clearance %s, a hosted asset labelled %s: on the map only if they can see it',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const res = await getMap(env, who, assetCentre.id, 1);
      const body = mapBody(res);
      const target = assetByLabel[label];
      const edge = edgeKey(assetCentre, 'HOSTS', target);
      if (sees(clearance, label)) {
        expect(ids(body.nodes)).toContain(target.id);
        expect(edgeKeys(body.edges)).toContain(edge);
      } else {
        expect(ids(body.nodes)).not.toContain(target.id);
        expect(edgeKeys(body.edges)).not.toContain(edge);
        expect(res.body).not.toContain(target.id);
      }
    },
    T,
  );

  it.each(COMBOS)(
    '%s with clearance %s, the centre labelled %s: 200 or 404',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const res = await getMap(env, who, assetByLabel[label].id, 1);
      if (sees(clearance, label)) {
        const body = mapBody(res);
        expect(ids(body.nodes)).toEqual([assetByLabel[label].id, assetCentre.id].sort());
      } else {
        expect(refusal(res, 404).code).toBe('not_found');
      }
    },
    T,
  );
});
