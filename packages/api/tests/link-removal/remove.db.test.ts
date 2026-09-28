// S1-011 criteria 1, 4, 5 and 7: removing a link through POST /api/v1/links/remove (D201, D200,
// D51, D45.4, D37, D56, D186, D69).
// 1. Both ends must exist in the caller's org and be visible, and the link must exist, or 404
//    `not_found` (the same answer for a missing end, a hidden end or no such link); then
//    `canLinkRecords` or 403 `forbidden`.
// 4. Only that one relationship is deleted; other links between the same two records (another type,
//    the reverse direction) stay, and both records keep every field and their `version`.
// 5. The removal and its `link.removed` entry go through `AuditOutbox.withAuditedWrite` in one Neo4j
//    transaction: the entry holds the full copy of the link; if the transaction fails, the link
//    stays and no entry is kept. (The relay to Postgres is audit-relay.db.test.ts.)
// 7. Afterwards the link is gone from both ends' link lists and from the asset map, and adding it
//    again is 201 with a new `link.created` entry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GHOST,
  LONG,
  T,
  answered,
  body,
  edgeKey,
  edgeKeys,
  getLinks,
  getMap,
  higherLabel,
  json,
  linkCount,
  linkItems,
  makeRecord,
  mapBody,
  newLinksOrg,
  nodeProps,
  outboxEntries,
  person,
  postLink,
  refusal,
  removeLink,
  removed,
  seedLink,
  setUpRemoval,
  show,
  targetIdOf,
  tearDownRemoval,
  type Label,
  type Person,
  type Rec,
  type RecordKind,
  type RemovalEnv,
} from './helpers.js';

let env: RemovalEnv;
let orgId: string;
let admin: Person;
let adminInternal: Person;
let riskManager: Person;
let viewer: Person;
let controlOwner: Person;

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  adminInternal = await person(env, org, 'admin', 'internal');
  riskManager = await person(env, org, 'risk_manager', 'restricted');
  viewer = await person(env, org, 'viewer', 'restricted');
  controlOwner = await person(env, org, 'control_owner', 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

async function rec(kind: RecordKind, label: Label = 'internal', owner?: string): Promise<Rec> {
  return makeRecord(env, admin, kind, { label, ...(owner !== undefined ? { owner } : {}) });
}

async function link(type: string, from: Rec, to: Rec, origin: 'manual' | 'import' | 'ai' = 'manual') {
  return seedLink(env, orgId, type, from, to, { origin, createdBy: admin.id });
}

describe('criterion 1: who may remove a link (D200, D201)', () => {
  it(
    'an Admin removes a manual link: 200 with { type, fromId, toId }, the link is gone',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await link('MITIGATED_BY', risk, control);
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
    },
    T,
  );

  it(
    'a Risk Manager removes a MITIGATED_BY link from their risk to a control they can only view',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await link('MITIGATED_BY', risk, control);
      removed(
        await removeLink(env, riskManager, body('MITIGATED_BY', risk, control)),
        body('MITIGATED_BY', risk, control),
      );
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
    },
    T,
  );

  it(
    'a Control Owner removes a link through a control they own',
    async () => {
      const control = await rec('control', 'internal', controlOwner.id);
      const policy = await rec('policy');
      await link('GOVERNED_BY', control, policy);
      removed(
        await removeLink(env, controlOwner, body('GOVERNED_BY', control, policy)),
        body('GOVERNED_BY', control, policy),
      );
      expect(await linkCount(env, orgId, 'GOVERNED_BY', control.id, policy.id)).toBe(0);
    },
    T,
  );

  it(
    "a Control Owner can't remove a link through someone else's control: 404, the link stays",
    async () => {
      const notTheirs = await rec('control', 'internal', admin.id);
      const policy = await rec('policy');
      const risk = await rec('risk');
      await link('GOVERNED_BY', notTheirs, policy);
      await link('MITIGATED_BY', risk, notTheirs);
      expect(refusal(await removeLink(env, controlOwner, body('GOVERNED_BY', notTheirs, policy)), 404).code).toBe(
        'not_found',
      );
      expect(refusal(await removeLink(env, controlOwner, body('MITIGATED_BY', risk, notTheirs)), 404).code).toBe(
        'not_found',
      );
      expect(await linkCount(env, orgId, 'GOVERNED_BY', notTheirs.id, policy.id)).toBe(1);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, notTheirs.id)).toBe(1);
    },
    T,
  );

  it(
    'a Viewer can remove nothing, even a link between records they see: 403 forbidden, the link stays',
    async () => {
      const risk = await rec('risk', 'public');
      const control = await rec('control', 'public');
      await link('MITIGATED_BY', risk, control);
      expect(refusal(await removeLink(env, viewer, body('MITIGATED_BY', risk, control)), 403).code).toBe('forbidden');
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
    },
    T,
  );

  it(
    'a Risk Manager may not remove a control-to-policy link (they can edit neither end): 403',
    async () => {
      const control = await rec('control');
      const policy = await rec('policy');
      await link('GOVERNED_BY', control, policy);
      expect(refusal(await removeLink(env, riskManager, body('GOVERNED_BY', control, policy)), 403).code).toBe(
        'forbidden',
      );
      expect(await linkCount(env, orgId, 'GOVERNED_BY', control.id, policy.id)).toBe(1);
    },
    T,
  );
});

describe('criterion 1: 404 is the same answer for a missing end, a hidden end and no such link', () => {
  it(
    'a made-up ID at either end, an end above the clearance at either end, and no link: one answer',
    async () => {
      const risk = await rec('risk', 'internal');
      const control = await rec('control', 'internal');
      const riskHidden = await rec('risk', 'confidential');
      const controlHidden = await rec('control', 'confidential');
      const lonelyRisk = await rec('risk', 'internal');
      const lonelyControl = await rec('control', 'internal');
      await link('MITIGATED_BY', risk, controlHidden);
      await link('MITIGATED_BY', riskHidden, control);
      const answers = [
        await removeLink(env, adminInternal, { type: 'MITIGATED_BY', fromId: GHOST, toId: control.id }),
        await removeLink(env, adminInternal, { type: 'MITIGATED_BY', fromId: risk.id, toId: GHOST }),
        await removeLink(env, adminInternal, body('MITIGATED_BY', risk, controlHidden)),
        await removeLink(env, adminInternal, body('MITIGATED_BY', riskHidden, control)),
        await removeLink(env, adminInternal, body('MITIGATED_BY', lonelyRisk, lonelyControl)),
      ].map((res) => refusal(res, 404));
      expect(answers[0]!.code).toBe('not_found');
      for (const a of answers) expect(a).toEqual(answers[0]);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, controlHidden.id)).toBe(1);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', riskHidden.id, control.id)).toBe(1);
    },
    T,
  );

  it(
    'a link of another type between the same two records, or the reverse direction, is not this link: 404',
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      await link('HOSTS', a, b);
      expect(refusal(await removeLink(env, admin, body('RUNS', a, b)), 404).code).toBe('not_found');
      expect(refusal(await removeLink(env, admin, body('HOSTS', b, a)), 404).code).toBe('not_found');
      expect(await linkCount(env, orgId, 'HOSTS', a.id, b.id)).toBe(1);
    },
    T,
  );

  it(
    'a hidden end comes before 403: a Viewer with clearance internal gets 404 on a link to a confidential record',
    async () => {
      const viewerInternal = await person(env, admin.org, 'viewer', 'internal');
      const risk = await rec('risk', 'internal');
      const control = await rec('control', 'confidential');
      await link('MITIGATED_BY', risk, control);
      expect(refusal(await removeLink(env, viewerInternal, body('MITIGATED_BY', risk, control)), 404).code).toBe(
        'not_found',
      );
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
    },
    T,
  );

  it(
    'a Viewer and an incident (a type their role never sees): 404, not 403',
    async () => {
      const incident = await rec('incident');
      const asset = await rec('asset');
      await link('IMPACTS', incident, asset);
      expect(refusal(await removeLink(env, viewer, body('IMPACTS', incident, asset)), 404).code).toBe('not_found');
      expect(await linkCount(env, orgId, 'IMPACTS', incident.id, asset.id)).toBe(1);
    },
    T,
  );

  it(
    'a refused removal writes no audit entry',
    async () => {
      const risk = await rec('risk', 'public');
      const control = await rec('control', 'public');
      await link('MITIGATED_BY', risk, control);
      const before = (await outboxEntries(env, orgId)).length;
      refusal(await removeLink(env, viewer, body('MITIGATED_BY', risk, control)), 403);
      refusal(await removeLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: GHOST }), 404);
      refusal(await removeLink(env, admin, body('OWNS', risk, control)), 400);
      expect((await outboxEntries(env, orgId)).length).toBe(before);
    },
    T,
  );
});

describe('criterion 4: only that one relationship goes; the records are unchanged', () => {
  it(
    'HOSTS a->b is removed; RUNS a->b and HOSTS b->a stay',
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      await link('HOSTS', a, b);
      await link('RUNS', a, b);
      await link('HOSTS', b, a);
      removed(await removeLink(env, admin, body('HOSTS', a, b)), body('HOSTS', a, b));
      expect(await linkCount(env, orgId, 'HOSTS', a.id, b.id)).toBe(0);
      expect(await linkCount(env, orgId, 'RUNS', a.id, b.id)).toBe(1);
      expect(await linkCount(env, orgId, 'HOSTS', b.id, a.id)).toBe(1);
    },
    T,
  );

  it(
    'links to other records stay: removing risk->control1 leaves risk->control2 and asset->risk',
    async () => {
      const risk = await rec('risk');
      const control1 = await rec('control');
      const control2 = await rec('control');
      const asset = await rec('asset');
      await link('MITIGATED_BY', risk, control1);
      await link('MITIGATED_BY', risk, control2);
      await link('EXPOSED_TO', asset, risk);
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control1)), body('MITIGATED_BY', risk, control1));
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control1.id)).toBe(0);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control2.id)).toBe(1);
      expect(await linkCount(env, orgId, 'EXPOSED_TO', asset.id, risk.id)).toBe(1);
    },
    T,
  );

  it(
    'both records keep every field and their version',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await link('MITIGATED_BY', risk, control);
      const fromBefore = await nodeProps(env, orgId, risk.id);
      const toBefore = await nodeProps(env, orgId, control.id);
      removed(
        await removeLink(env, riskManager, body('MITIGATED_BY', risk, control)),
        body('MITIGATED_BY', risk, control),
      );
      expect(await nodeProps(env, orgId, risk.id)).toEqual(fromBefore);
      expect(await nodeProps(env, orgId, control.id)).toEqual(toBefore);
    },
    T,
  );
});

describe('criterion 5: the link.removed entry, in the same transaction', () => {
  it(
    'one link.removed entry: the actor, the link.created key, the full copy in before, after null, meta',
    async () => {
      const asset = await rec('asset', 'public');
      const risk = await rec('risk', 'confidential');
      const created = await postLink(env, admin, body('EXPOSED_TO', asset, risk));
      expect(created.statusCode, show(created)).toBe(201);
      const stored = json(created) as { createdAt: string; createdBy: string };
      const createdEntry = (await outboxEntries(env, orgId, 'link.created')).find(
        (e) => e.meta?.['fromNumber'] === asset.number && e.meta?.['toNumber'] === risk.number,
      );
      expect(createdEntry, 'the link.created entry').toBeDefined();
      const before = (await outboxEntries(env, orgId, 'link.removed')).length;

      removed(await removeLink(env, admin, body('EXPOSED_TO', asset, risk)), body('EXPOSED_TO', asset, risk));

      const entries = await outboxEntries(env, orgId, 'link.removed');
      expect(entries).toHaveLength(before + 1);
      const entry = entries[entries.length - 1]!;
      expect(entry.actorType).toBe('user');
      expect(entry.actorId).toBe(admin.id);
      expect(entry.targetType).toBe('link');
      expect(entry.targetId).toBe(createdEntry!.targetId);
      expect(entry.targetId).toBe(await targetIdOf('EXPOSED_TO', asset.id, risk.id));
      expect(entry.before).toEqual({
        type: 'EXPOSED_TO',
        fromId: asset.id,
        toId: risk.id,
        fromNumber: asset.number,
        toNumber: risk.number,
        createdAt: stored.createdAt,
        createdBy: stored.createdBy,
        origin: 'manual',
      });
      expect(entry.after).toBeNull();
      expect(entry.meta).toEqual({
        type: 'EXPOSED_TO',
        fromNumber: asset.number,
        toNumber: risk.number,
        label: 'confidential',
      });
    },
    T,
  );

  const LABELS4 = ['public', 'internal', 'confidential', 'restricted'] as const;
  const PAIRS = LABELS4.flatMap((a) => LABELS4.map((b) => [a, b] as const));

  it.each(PAIRS)(
    "from %s, to %s: meta.label is the higher of the two ends' labels",
    async (fromLabel, toLabel) => {
      const a = await rec('asset', fromLabel);
      const b = await rec('asset', toLabel);
      await link('RUNS', a, b);
      removed(await removeLink(env, admin, body('RUNS', a, b)), body('RUNS', a, b));
      const entry = (await outboxEntries(env, orgId, 'link.removed')).find(
        (e) => e.meta?.['fromNumber'] === a.number && e.meta?.['toNumber'] === b.number,
      );
      expect(entry, 'the link.removed entry').toBeDefined();
      expect(entry!.meta?.['label']).toBe(higherLabel(fromLabel, toLabel));
    },
    T,
  );

  it(
    'the removal goes through withAuditedWrite: when the transaction fails, the link stays and no entry is kept',
    async () => {
      const { AuditOutbox } = await import('../../src/audit/outbox.js');
      const outbox = env.app.get<{
        withAuditedWrite: (orgId: string, actor: unknown, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      }>(AuditOutbox);
      const risk = await rec('risk');
      const control = await rec('control');
      await link('MITIGATED_BY', risk, control);
      const beforeEntries = (await outboxEntries(env, orgId)).length;
      const real = outbox.withAuditedWrite;
      let used = 0;
      outbox.withAuditedWrite = function (this: unknown, org, actor, fn) {
        used += 1;
        return real.call(this, org, actor, async (tx: unknown) => {
          await fn(tx);
          throw new Error('injected failure after the link was removed');
        });
      };
      let res;
      try {
        res = await removeLink(env, admin, body('MITIGATED_BY', risk, control));
      } finally {
        outbox.withAuditedWrite = real;
      }
      expect(answered(res), show(res)).toBeGreaterThanOrEqual(500);
      expect(used, 'the removal is written through AuditOutbox.withAuditedWrite').toBeGreaterThan(0);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
      expect((await outboxEntries(env, orgId)).length).toBe(beforeEntries);
      // And after the failure, the same link can be removed.
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
    },
    T,
  );
});

describe('criterion 7: after removal', () => {
  it(
    "the link is in neither end's link list",
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await link('MITIGATED_BY', risk, control);
      expect(linkItems(await getLinks(env, admin, 'risk', risk.id)).map((i) => i.other.id)).toEqual([control.id]);
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));
      expect(linkItems(await getLinks(env, admin, 'risk', risk.id))).toEqual([]);
      expect(linkItems(await getLinks(env, admin, 'control', control.id))).toEqual([]);
    },
    T,
  );

  it(
    'a removed HOSTS link is gone from the asset map',
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      await link('HOSTS', a, b);
      expect(edgeKeys(mapBody(await getMap(env, admin, a.id, 1)).edges)).toContain(edgeKey(a, 'HOSTS', b));
      removed(await removeLink(env, admin, body('HOSTS', a, b)), body('HOSTS', a, b));
      const after = mapBody(await getMap(env, admin, a.id, 1));
      expect(edgeKeys(after.edges)).not.toContain(edgeKey(a, 'HOSTS', b));
      expect(after.nodes.map((n) => n.id)).toEqual([a.id]);
    },
    T,
  );

  it(
    'adding the same link again is 201, not link_exists, with a new link.created entry',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const first = await postLink(env, admin, body('MITIGATED_BY', risk, control));
      expect(first.statusCode, show(first)).toBe(201);
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));
      const again = await postLink(env, admin, body('MITIGATED_BY', risk, control));
      expect(again.statusCode, show(again)).toBe(201);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
      const key = await targetIdOf('MITIGATED_BY', risk.id, control.id);
      const history = (await outboxEntries(env, orgId)).filter((e) => e.targetId === key).map((e) => e.action);
      expect(history).toEqual(['link.created', 'link.removed', 'link.created']);
    },
    T,
  );
});
