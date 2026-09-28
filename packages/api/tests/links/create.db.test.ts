// S1-005 criteria 1 and 2: creating a link through POST /api/v1/links (D200, D51, D45.4, D69, D73).
// 1. Both ends must exist in the caller's org and be visible, or 404 whichever end it is. The
//    ontology (`isAllowedLink`) or 400 `link_not_allowed`; D200 (`canLinkRecords`) or 403. A link
//    to itself is 400; the same type, from and to twice is 409 `link_exists`.
// 2. The link saves `createdAt`, `createdBy` and `origin: 'manual'`, plus one `link.created` audit
//    entry in the same transaction, with `meta { type, fromNumber, toNumber, label }` where the label
//    is the higher of the two ends' labels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  higherLabel,
  json,
  makeRecord,
  newLinksOrg,
  outboxEntries,
  person,
  postLink,
  refusal,
  relationshipCount,
  setUpLinks,
  show,
  storedLinks,
  tearDownLinks,
  type Label,
  type LinksEnv,
  type Person,
  type Rec,
} from './helpers.js';

let env: LinksEnv;
let admin: Person;
let riskManager: Person;
let viewer: Person;
let viewerInternal: Person;
let controlOwner: Person;
let orgId: string;

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links Create');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  riskManager = await person(env, org, 'risk_manager', 'restricted');
  viewer = await person(env, org, 'viewer', 'restricted');
  viewerInternal = await person(env, org, 'viewer', 'internal');
  controlOwner = await person(env, org, 'control_owner', 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

async function rec(kind: Rec['kind'], label: Label = 'internal', owner?: string): Promise<Rec> {
  return makeRecord(env, admin, kind, { label, ...(owner !== undefined ? { owner } : {}) });
}

describe('criterion 1: a link between two visible records the caller may edit', () => {
  it(
    'an Admin links a risk to a control: 201 with the link',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const res = await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id });
      expect(res.statusCode, show(res)).toBe(201);
      expect(json(res)).toMatchObject({
        type: 'MITIGATED_BY',
        fromId: risk.id,
        toId: control.id,
        origin: 'manual',
        createdBy: admin.id,
      });
      expect(typeof json(res)['createdAt']).toBe('string');
    },
    T,
  );

  it(
    'a Risk Manager may link their risk to a control they can only view (D200)',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const res = await postLink(env, riskManager, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id });
      expect(res.statusCode, show(res)).toBe(201);
    },
    T,
  );

  it(
    'a Control Owner may link their own control to a policy (edit_own, D200)',
    async () => {
      const control = await rec('control', 'internal', controlOwner.id);
      const policy = await rec('policy');
      const res = await postLink(env, controlOwner, { type: 'GOVERNED_BY', fromId: control.id, toId: policy.id });
      expect(res.statusCode, show(res)).toBe(201);
    },
    T,
  );
});

describe('criterion 1: an end that is missing or hidden is 404, the same answer for either end', () => {
  it(
    'a made-up ID at either end: 404 not_found, the same code and message, nothing saved',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const ghost = '00000000-0000-4000-8000-000000000001';
      const before = await relationshipCount(env, orgId);
      const a = refusal(await postLink(env, admin, { type: 'MITIGATED_BY', fromId: ghost, toId: control.id }), 404);
      const b = refusal(await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: ghost }), 404);
      expect(a.code).toBe('not_found');
      expect(b).toEqual(a);
      expect(await relationshipCount(env, orgId)).toBe(before);
    },
    T,
  );

  it(
    "an end above the caller's clearance: 404, the same as a missing one, whichever end",
    async () => {
      const riskHidden = await rec('risk', 'confidential');
      const riskShown = await rec('risk', 'internal');
      const controlHidden = await rec('control', 'confidential');
      const controlShown = await rec('control', 'internal');
      const ghost = '00000000-0000-4000-8000-000000000002';
      const missing = refusal(
        await postLink(env, viewerInternal, { type: 'MITIGATED_BY', fromId: ghost, toId: controlShown.id }),
        404,
      );
      // A Viewer can't edit either end, but hiding comes first: the answer must not reveal the record.
      const fromHidden = refusal(
        await postLink(env, viewerInternal, { type: 'MITIGATED_BY', fromId: riskHidden.id, toId: controlShown.id }),
        404,
      );
      const toHidden = refusal(
        await postLink(env, viewerInternal, { type: 'MITIGATED_BY', fromId: riskShown.id, toId: controlHidden.id }),
        404,
      );
      expect(fromHidden).toEqual(missing);
      expect(toHidden).toEqual(missing);
    },
    T,
  );

  it(
    'a Risk Manager with clearance internal may not link their risk to a confidential control: 404',
    async () => {
      const rmInternal = await person(env, admin.org, 'risk_manager', 'internal');
      const risk = await rec('risk', 'internal');
      const control = await rec('control', 'confidential');
      const r = refusal(
        await postLink(env, rmInternal, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id }),
        404,
      );
      expect(r.code).toBe('not_found');
      expect(await storedLinks(env, orgId, risk.id, control.id)).toHaveLength(0);
    },
    T,
  );

  it(
    "a Control Owner linking someone else's control: 404 (they can't see it)",
    async () => {
      const notTheirs = await rec('control', 'internal', admin.id);
      const policy = await rec('policy');
      const risk = await rec('risk');
      refusal(await postLink(env, controlOwner, { type: 'GOVERNED_BY', fromId: notTheirs.id, toId: policy.id }), 404);
      refusal(await postLink(env, controlOwner, { type: 'MITIGATED_BY', fromId: risk.id, toId: notTheirs.id }), 404);
      expect(await storedLinks(env, orgId, notTheirs.id, policy.id)).toHaveLength(0);
      expect(await storedLinks(env, orgId, risk.id, notTheirs.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'a Viewer linking an incident (a type their role never sees): 404',
    async () => {
      const incident = await rec('incident', 'internal');
      const asset = await rec('asset', 'internal');
      refusal(await postLink(env, viewer, { type: 'IMPACTS', fromId: incident.id, toId: asset.id }), 404);
    },
    T,
  );
});

describe('criterion 1: the ontology (isAllowedLink) or 400 link_not_allowed', () => {
  it.each([
    ['MITIGATED_BY in the wrong direction (control to risk)', 'MITIGATED_BY', 'control', 'risk'],
    ['HOSTS from an asset to a risk', 'HOSTS', 'asset', 'risk'],
    ['EXPOSED_TO from a risk to an asset', 'EXPOSED_TO', 'risk', 'asset'],
    ['GOVERNED_BY from a risk to a policy', 'GOVERNED_BY', 'risk', 'policy'],
    ['IMPACTS from an incident to a risk', 'IMPACTS', 'incident', 'risk'],
    ['EXPOSES from an asset to a risk', 'EXPOSES', 'asset', 'risk'],
  ] as const)(
    '%s',
    async (_what, type, fromKind, toKind) => {
      const from = await rec(fromKind);
      const to = await rec(toKind);
      const r = refusal(await postLink(env, admin, { type, fromId: from.id, toId: to.id }), 400);
      expect(r.code).toBe('link_not_allowed');
      expect(await storedLinks(env, orgId, from.id, to.id, true)).toHaveLength(0);
    },
    T,
  );

  it(
    'a link type outside the ontology (a later slice or made up) is 400',
    async () => {
      const control = await rec('control');
      const policy = await rec('policy');
      for (const type of ['SATISFIES', 'OWNS', 'governed_by', '']) {
        const res = await postLink(env, admin, { type, fromId: control.id, toId: policy.id });
        refusal(res, 400);
      }
      expect(await storedLinks(env, orgId, control.id, policy.id, true)).toHaveLength(0);
    },
    T,
  );

  it(
    'a body missing type, fromId or toId is 400',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      refusal(await postLink(env, admin, { fromId: risk.id, toId: control.id }), 400);
      refusal(await postLink(env, admin, { type: 'MITIGATED_BY', toId: control.id }), 400);
      refusal(await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id }), 400);
      refusal(await postLink(env, admin, {}), 400);
      expect(await storedLinks(env, orgId, risk.id, control.id)).toHaveLength(0);
    },
    T,
  );
});

describe('criterion 1: D200 (canLinkRecords) or 403', () => {
  it(
    'a Viewer may link nothing, even records they can see',
    async () => {
      const risk = await rec('risk', 'public');
      const control = await rec('control', 'public');
      const r = refusal(await postLink(env, viewer, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id }), 403);
      expect(r.code).toBe('forbidden');
      expect(await storedLinks(env, orgId, risk.id, control.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'a Risk Manager may not link a control to a policy (they can edit neither)',
    async () => {
      const control = await rec('control');
      const policy = await rec('policy');
      refusal(await postLink(env, riskManager, { type: 'GOVERNED_BY', fromId: control.id, toId: policy.id }), 403);
      expect(await storedLinks(env, orgId, control.id, policy.id)).toHaveLength(0);
    },
    T,
  );
});

describe('criterion 1: a link to itself is 400, the same link twice is 409', () => {
  it(
    'an asset that HOSTS itself: 400, nothing saved',
    async () => {
      const asset = await rec('asset');
      refusal(await postLink(env, admin, { type: 'HOSTS', fromId: asset.id, toId: asset.id }), 400);
      expect(await storedLinks(env, orgId, asset.id, asset.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'the same type, from and to twice: 409 link_exists, one link and one audit entry',
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      const first = await postLink(env, admin, { type: 'HOSTS', fromId: a.id, toId: b.id });
      expect(first.statusCode, show(first)).toBe(201);
      const second = refusal(await postLink(env, admin, { type: 'HOSTS', fromId: a.id, toId: b.id }), 409);
      expect(second.code).toBe('link_exists');
      expect(await storedLinks(env, orgId, a.id, b.id)).toHaveLength(1);
      const entries = (await outboxEntries(env, orgId, 'link.created')).filter(
        (e) => e.meta?.['fromNumber'] === a.number && e.meta?.['toNumber'] === b.number,
      );
      expect(entries).toHaveLength(1);
    },
    T,
  );

  it(
    'a different type between the same two assets is a different link (RUNS next to HOSTS)',
    async () => {
      const a = await rec('asset');
      const b = await rec('asset');
      expect((await postLink(env, admin, { type: 'HOSTS', fromId: a.id, toId: b.id })).statusCode).toBe(201);
      const runs = await postLink(env, admin, { type: 'RUNS', fromId: a.id, toId: b.id });
      expect(runs.statusCode, show(runs)).toBe(201);
      expect((await storedLinks(env, orgId, a.id, b.id)).map((l) => l.type).sort()).toEqual(['HOSTS', 'RUNS']);
    },
    T,
  );
});

describe('criterion 2: what a link saves', () => {
  it(
    'the relationship carries createdAt, createdBy and origin manual',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const startedAt = Date.now();
      const res = await postLink(env, riskManager, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id });
      expect(res.statusCode, show(res)).toBe(201);
      const stored = await storedLinks(env, orgId, risk.id, control.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.type).toBe('MITIGATED_BY');
      const props = stored[0]!.props;
      expect(props['createdBy']).toBe(riskManager.id);
      expect(props['origin']).toBe('manual');
      const at = Date.parse(String(props['createdAt']));
      expect(Number.isNaN(at), `createdAt is a date: ${String(props['createdAt'])}`).toBe(false);
      expect(at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    },
    T,
  );

  it(
    'one link.created audit entry, by the caller, about a link, with meta { type, fromNumber, toNumber, label }',
    async () => {
      const asset = await rec('asset', 'public');
      const risk = await rec('risk', 'confidential');
      const before = (await outboxEntries(env, orgId, 'link.created')).length;
      const res = await postLink(env, admin, { type: 'EXPOSED_TO', fromId: asset.id, toId: risk.id });
      expect(res.statusCode, show(res)).toBe(201);
      const entries = await outboxEntries(env, orgId, 'link.created');
      expect(entries).toHaveLength(before + 1);
      const entry = entries[entries.length - 1]!;
      expect(entry.actorType).toBe('user');
      expect(entry.actorId).toBe(admin.id);
      expect(entry.targetType).toBe('link');
      expect(typeof entry.targetId).toBe('string');
      expect(entry.targetId.length).toBeGreaterThan(0);
      expect(entry.meta).toEqual({
        type: 'EXPOSED_TO',
        fromNumber: asset.number,
        toNumber: risk.number,
        label: 'confidential',
      });
    },
    T,
  );

  const LABEL_PAIRS = (['public', 'internal', 'confidential', 'restricted'] as const).flatMap((a) =>
    (['public', 'internal', 'confidential', 'restricted'] as const).map((b) => [a, b] as const),
  );

  it.each(LABEL_PAIRS)(
    "the entry's label is the higher of the two ends' labels (from %s, to %s)",
    async (fromLabel, toLabel) => {
      const a = await rec('asset', fromLabel);
      const b = await rec('asset', toLabel);
      const res = await postLink(env, admin, { type: 'RUNS', fromId: a.id, toId: b.id });
      expect(res.statusCode, show(res)).toBe(201);
      const entry = (await outboxEntries(env, orgId, 'link.created')).find(
        (e) => e.meta?.['fromNumber'] === a.number && e.meta?.['toNumber'] === b.number,
      );
      expect(entry, 'the link.created entry').toBeDefined();
      expect(entry!.meta?.['label']).toBe(higherLabel(fromLabel, toLabel));
    },
    T,
  );

  it(
    'a refused link writes no audit entry',
    async () => {
      const risk = await rec('risk', 'public');
      const control = await rec('control', 'public');
      const before = (await outboxEntries(env, orgId)).length;
      refusal(await postLink(env, viewer, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id }), 403);
      refusal(await postLink(env, admin, { type: 'MITIGATED_BY', fromId: control.id, toId: risk.id }), 400);
      refusal(await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: risk.id }), 400);
      expect((await outboxEntries(env, orgId)).length).toBe(before);
    },
    T,
  );

  it(
    'the link and its audit entry are one transaction: when the audit write fails, no link is kept',
    async () => {
      const { AuditOutbox } = await import('../../src/audit/outbox.js');
      const outbox = env.app.get<{
        withAuditedWrite: (orgId: string, actor: unknown, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      }>(AuditOutbox);
      const risk = await rec('risk');
      const control = await rec('control');
      const beforeEntries = (await outboxEntries(env, orgId)).length;
      const real = outbox.withAuditedWrite;
      let used = 0;
      outbox.withAuditedWrite = function (this: unknown, org, actor, fn) {
        used += 1;
        return real.call(this, org, actor, async (tx: unknown) => {
          await fn(tx);
          throw new Error('injected failure after the link was written');
        });
      };
      let res;
      try {
        res = await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id });
      } finally {
        outbox.withAuditedWrite = real;
      }
      expect(used, 'the link is written through AuditOutbox.withAuditedWrite').toBeGreaterThan(0);
      expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(500);
      expect(await storedLinks(env, orgId, risk.id, control.id)).toHaveLength(0);
      expect((await outboxEntries(env, orgId)).length).toBe(beforeEntries);
      // And after the failure, the same link can be made.
      const again = await postLink(env, admin, { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id });
      expect(again.statusCode, show(again)).toBe(201);
    },
    T,
  );
});
