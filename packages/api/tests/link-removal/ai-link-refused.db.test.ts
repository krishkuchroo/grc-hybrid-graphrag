// S1-011 criterion 2 (D207, D201, D200): POST /api/v1/links/remove removes only links with origin
// `manual` or `import`. An `ai` link is refused with 409 `ai_link_review_only` and the message
// "This link was found by the AI. It can only be removed through the Analyst's review." in the D47
// format, for every role (Admin included) and for API keys: the link stays, both records keep their
// `version`, and the Postgres audit trail gains no `link.removed` entry. The order is 404, then 403,
// then the origin: a caller who can't see an end gets 404 and a caller who may not remove gets 403,
// never the 409, so the origin of a link they couldn't remove anyway isn't revealed.
//
// The `ai` and `import` links are written straight into this file's throwaway org database (S1
// makes none). The worker runs against this file's throwaway Postgres database, so "no entry in
// Postgres" is checked after a later removal's entry has arrived there: the relay copies entries in
// the order they were written, so anything written before that entry would have arrived too.
import { ROLE_TABLE } from '@grc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_MESSAGE,
  LONG,
  LINK_ROWS,
  ROLES,
  T,
  answered,
  auditRows,
  body,
  cellOf,
  createKey,
  linkCount,
  makeRecord,
  mayEdit,
  mayView,
  newLinksOrg,
  nodeProps,
  person,
  refusal,
  relayed,
  removeLink,
  removeWithKey,
  removed,
  seedLink,
  setUpRemoval,
  show,
  targetIdOf,
  tearDownRemoval,
  type InjectResponse,
  type Label,
  type NewKey,
  type Person,
  type Rec,
  type RecordKind,
  type RemovalEnv,
  type Role,
} from './helpers.js';

const TABLE = ROLE_TABLE as unknown as Record<string, Record<string, string>>;

let env: RemovalEnv;
let orgId: string;
const people = {} as Record<Role, Person>;
const keys = {} as Record<Role, NewKey>;

beforeAll(async () => {
  env = await setUpRemoval({ worker: true });
  const org = await newLinksOrg(env, 'Link Removal AI');
  orgId = org.id;
  for (const role of ROLES) people[role] = await person(env, org, role, 'restricted');
  for (const role of ROLES) keys[role] = await createKey(env.app, people.admin.signedIn, { role, name: `${role} key` });
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

async function rec(kind: RecordKind, label: Label = 'internal', owner?: string): Promise<Rec> {
  return makeRecord(env, people.admin, kind, { label, ...(owner !== undefined ? { owner } : {}) });
}

/** The 409 answer: the code and the exact message, in the D47 format. */
function aiRefusal(res: InjectResponse): void {
  const r = refusal(res, 409);
  expect(r.code).toBe('ai_link_review_only');
  expect(r.message).toBe(AI_MESSAGE);
}

/**
 * Checks that nothing about the refused link changed: the link is there, both records are as they
 * were, and the Postgres audit trail has no `link.removed` entry for it. The last part removes a
 * fresh `import` link as a marker and waits for the marker's entry, so the refused request's
 * entry, had one been written, would have been relayed by then.
 */
async function expectUntouched(
  type: string,
  from: Rec,
  to: Rec,
  snapshot: { from: Record<string, unknown>; to: Record<string, unknown> },
): Promise<void> {
  expect(await linkCount(env, orgId, type, from.id, to.id)).toBe(1);
  expect(await nodeProps(env, orgId, from.id)).toEqual(snapshot.from);
  expect(await nodeProps(env, orgId, to.id)).toEqual(snapshot.to);
  const ma = await rec('asset');
  const mb = await rec('asset');
  await seedLink(env, orgId, 'HOSTS', ma, mb, { origin: 'import' });
  removed(await removeLink(env, people.admin, body('HOSTS', ma, mb)), body('HOSTS', ma, mb));
  await relayed(env, orgId, 'link.removed', await targetIdOf('HOSTS', ma.id, mb.id));
  const key = await targetIdOf(type, from.id, to.id);
  const rows = (await auditRows(env, orgId, 'link.removed')).filter((r) => r.target_id === key);
  expect(rows, 'no link.removed entry for the refused link').toEqual([]);
}

async function snap(from: Rec, to: Rec) {
  return { from: await nodeProps(env, orgId, from.id), to: await nodeProps(env, orgId, to.id) };
}

describe('criterion 2: an ai link is refused with 409, the link and the records untouched', () => {
  it(
    'an Admin: 409 ai_link_review_only',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      aiRefusal(await removeLink(env, people.admin, body('MITIGATED_BY', risk, control)));
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    'an editor of the from end (a Risk Manager on their risk): 409',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      aiRefusal(await removeLink(env, people.risk_manager, body('MITIGATED_BY', risk, control)));
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    'an editor of the to end (a Control Owner on their own control): 409',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control', 'internal', people.control_owner.id);
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      aiRefusal(await removeLink(env, people.control_owner, body('MITIGATED_BY', risk, control)));
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    'an Admin API key: 409',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      aiRefusal(await removeWithKey(env, keys.admin, body('MITIGATED_BY', risk, control)));
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    'a Viewer on the same kind of link: 403, not 409',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      expect(refusal(await removeLink(env, people.viewer, body('MITIGATED_BY', risk, control)), 403).code).toBe(
        'forbidden',
      );
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    "a caller who can't see an end: 404, not 409 (a Risk Manager with clearance internal, a confidential control)",
    async () => {
      const rmInternal = await person(env, people.admin.org, 'risk_manager', 'internal');
      const risk = await rec('risk', 'internal');
      const control = await rec('control', 'confidential');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      expect(refusal(await removeLink(env, rmInternal, body('MITIGATED_BY', risk, control)), 404).code).toBe(
        'not_found',
      );
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );

  it(
    "a Control Owner on someone else's control: 404, not 409",
    async () => {
      const risk = await rec('risk');
      const control = await rec('control', 'internal', people.admin.id);
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'ai' });
      const s = await snap(risk, control);
      expect(refusal(await removeLink(env, people.control_owner, body('MITIGATED_BY', risk, control)), 404).code).toBe(
        'not_found',
      );
      await expectUntouched('MITIGATED_BY', risk, control, s);
    },
    T,
  );
});

describe('criterion 2: every role and every role key x link type, on ai links: 404, then 403, then 409', () => {
  // Controls belong to the Control Owner person (a key owns nothing, so for keys they are "not own").
  const cases = ROLES.flatMap((role) =>
    LINK_ROWS.flatMap((row) =>
      (['person', 'key'] as const).map((who) => [role, who, row.type, row.from, row.to] as const),
    ),
  );

  it(`covers 7 roles x 2 kinds of caller x ${LINK_ROWS.length} link types`, () => {
    expect(cases).toHaveLength(7 * 2 * LINK_ROWS.length);
  });

  it.each(cases)(
    '%s (%s): %s (%s -> %s)',
    async (role, who, type, fromKind, toKind) => {
      const own = (kind: RecordKind) => (kind === 'control' ? people.control_owner.id : undefined);
      const from = await rec(fromKind, 'internal', own(fromKind));
      const to = await rec(toKind, 'internal', own(toKind));
      await seedLink(env, orgId, type, from, to, { origin: 'ai' });
      const owned = who === 'person' && role === 'control_owner';
      const fromCell = cellOf(TABLE, role, fromKind);
      const toCell = cellOf(TABLE, role, toKind);
      const want = !(mayView(fromCell, owned) && mayView(toCell, owned))
        ? 404
        : !(mayEdit(fromCell, owned) || mayEdit(toCell, owned))
          ? 403
          : 409;
      const res =
        who === 'person'
          ? await removeLink(env, people[role], body(type, from, to))
          : await removeWithKey(env, keys[role], body(type, from, to));
      expect(answered(res), `${role} ${who} ${type} (cells ${fromCell}/${toCell}): ${show(res)}`).toBe(want);
      if (want === 409) aiRefusal(res);
      expect(await linkCount(env, orgId, type, from.id, to.id)).toBe(1);
    },
    T,
  );
});

describe('criterion 2: an import link is removed', () => {
  it(
    'an Admin removes an import link: 200 and one link.removed entry in Postgres whose before.origin is import',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      const seeded = await seedLink(env, orgId, 'MITIGATED_BY', risk, control, {
        origin: 'import',
        createdBy: 'importer',
      });
      removed(
        await removeLink(env, people.admin, body('MITIGATED_BY', risk, control)),
        body('MITIGATED_BY', risk, control),
      );
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
      const key = await targetIdOf('MITIGATED_BY', risk.id, control.id);
      const row = await relayed(env, orgId, 'link.removed', key);
      expect(row.before).toMatchObject({ origin: 'import', createdBy: 'importer', createdAt: seeded.createdAt });
      expect((await auditRows(env, orgId, 'link.removed')).filter((r) => r.target_id === key)).toHaveLength(1);
    },
    T,
  );

  it(
    'a Risk Manager removes an import link from their risk: 200',
    async () => {
      const risk = await rec('risk');
      const control = await rec('control');
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin: 'import' });
      removed(
        await removeLink(env, people.risk_manager, body('MITIGATED_BY', risk, control)),
        body('MITIGATED_BY', risk, control),
      );
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
    },
    T,
  );
});
