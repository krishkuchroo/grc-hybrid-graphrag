// M0-009 criteria 3 and 4 (D9, D55, D73), plus the break-glass branch of app_visible_org.
// 3. An active auditor grant lets the auditor SELECT the other org's rows and nothing else.
//    An expired or revoked grant (even by one second) shows nothing.
// 4. An approved parent link gives the parent read-only access. A requested but unapproved
//    link gives nothing (nor does an ended one, since either side can end it, D55).
// Break-glass (D55): an open session gives its operator read-only access; an expired or
// ended one gives nothing.
//
// Orgs: A (the auditors' and operators' home), B (the audited org), C (unrelated),
// P (parent) with subsidiaries S (approved link), R (requested link) and E (ended link).
// Times are set with the database clock (`now() - interval '1 second'`), so the Mac's clock
// doesn't matter.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  addUser,
  adminCtx,
  asApp,
  attempt,
  countFor,
  fingerprint,
  insert,
  orgsSeen,
  orgTables,
  qualified,
  quoteIdent,
  rows,
  seedOrg,
  setUpWall,
  table,
  tableName,
  tearDownWall,
  type Ctx,
  type OrgTable,
  type SeededOrg,
  type Wall,
} from './helpers.js';

let wall: Wall | undefined;
let tables: OrgTable[] = [];
let A: SeededOrg, B: SeededOrg, C: SeededOrg, P: SeededOrg, S: SeededOrg, R: SeededOrg, E: SeededOrg;
const users: Record<string, string> = {};

function w(): Wall {
  if (!wall) throw new Error('set-up did not finish');
  return wall;
}

function ctxIn(org: SeededOrg, userId: string, role: Ctx['role'] = 'auditor'): Ctx {
  return { orgId: org.id, userId, role, clearance: 'restricted' };
}

async function auditorWithGrant(label: string, grant: Record<string, unknown> | null): Promise<string> {
  const id = await addUser(w(), label);
  await addMember(w(), A.id, id, 'auditor', 'restricted');
  if (grant) {
    await insert(w().sup, w().grants.auditorGrants!, { id: randomUUID(), orgId: B.id, userId: id, ...grant });
  }
  users[label] = id;
  return id;
}

async function operatorWithSession(label: string, session: Record<string, unknown>): Promise<string> {
  const id = await addUser(w(), label);
  await addMember(w(), A.id, id, 'viewer');
  await insert(w().sup, w().grants.breakGlassSessions!, {
    id: randomUUID(),
    orgId: B.id,
    userId: id,
    reason: `${label}: typed reason`,
    ...session,
  });
  users[label] = id;
  return id;
}

beforeAll(async () => {
  wall = await setUpWall();
  const { sql } = wall.loaded;
  A = await seedOrg(wall, 'Org A');
  B = await seedOrg(wall, 'Org B');
  C = await seedOrg(wall, 'Org C');
  P = await seedOrg(wall, 'Parent P');
  S = await seedOrg(wall, 'Subsidiary S');
  R = await seedOrg(wall, 'Subsidiary R');
  E = await seedOrg(wall, 'Subsidiary E');

  await auditorWithGrant('active auditor', { expiresAt: sql`now() + interval '30 days'`, revokedAt: null });
  await auditorWithGrant('expired auditor', { expiresAt: sql`now() - interval '1 second'`, revokedAt: null });
  await auditorWithGrant('revoked auditor', {
    expiresAt: sql`now() + interval '30 days'`,
    revokedAt: sql`now() - interval '1 second'`,
  });
  await auditorWithGrant('auditor without grant', null);

  await operatorWithSession('open operator', { expiresAt: sql`now() + interval '1 hour'`, endedAt: null });
  await operatorWithSession('expired operator', { expiresAt: sql`now() - interval '1 second'`, endedAt: null });
  await operatorWithSession('ended operator', {
    expiresAt: sql`now() + interval '1 hour'`,
    endedAt: sql`now() - interval '1 second'`,
  });

  await insert(wall.sup, wall.grants.parentLinks!, {
    id: randomUUID(),
    orgId: S.id,
    parentOrgId: P.id,
    status: 'approved',
  });
  await insert(wall.sup, wall.grants.parentLinks!, {
    id: randomUUID(),
    orgId: R.id,
    parentOrgId: P.id,
    status: 'requested',
  });
  await insert(wall.sup, wall.grants.parentLinks!, {
    id: randomUUID(),
    orgId: E.id,
    parentOrgId: P.id,
    status: 'ended',
  });

  tables = await orgTables(wall);
}, 180_000);

afterAll(async () => {
  await tearDownWall(wall);
});

// Tables where every seeded org has rows (organization, member, invitation).
function seededTables(): OrgTable[] {
  const names = ['organization', 'member', 'invitation'].map((k) => tableName(table(w().identity, k)).name);
  return tables.filter((t) => names.includes(t.name));
}

async function expectSees(ctx: Ctx, target: SeededOrg, how: string): Promise<void> {
  await asApp(w(), ctx, async (tx) => {
    for (const t of seededTables()) {
      const expected = await countFor(w(), w().sup, t, target.id);
      expect(expected, `${t.name}: seeded rows for ${target.name}`).toBeGreaterThan(0);
      expect(await countFor(w(), tx, t, target.id), `${how}: ${t.name} rows of ${target.name}`).toBe(expected);
    }
  });
}

async function expectSeesNone(ctx: Ctx, target: SeededOrg, how: string): Promise<void> {
  await asApp(w(), ctx, async (tx) => {
    for (const t of tables) {
      expect(await countFor(w(), tx, t, target.id), `${how}: ${t.name} rows of ${target.name}`).toBe(0);
    }
  });
}

async function expectSeesOnly(ctx: Ctx, allowed: SeededOrg[], how: string): Promise<void> {
  const ids = allowed.map((o) => o.id);
  await asApp(w(), ctx, async (tx) => {
    for (const t of tables) {
      const seen = await orgsSeen(w(), tx, t);
      expect(
        seen.filter((o) => !ids.includes(o)),
        `${how}: ${t.name} shows rows of orgs outside ${allowed.map((o) => o.name).join(', ')}`,
      ).toEqual([]);
    }
  });
}

// Tries to update, delete and insert the target org's rows; the superuser's fingerprint of
// every org table must not change.
async function expectCannotWrite(ctx: Ctx, target: SeededOrg): Promise<void> {
  const { sql } = w().loaded;
  const before = await fingerprint(w());
  for (const t of tables) {
    const key = quoteIdent(t.key);
    await attempt(() =>
      asApp(w(), ctx, (tx) =>
        rows(
          tx,
          sql`UPDATE ${sql.raw(qualified(t))} SET ${sql.raw(key)} = ${sql.raw(key)} WHERE ${sql.raw(key)} = ${target.id}::uuid RETURNING 1`,
        ),
      ),
    );
    await attempt(() =>
      asApp(w(), ctx, (tx) =>
        rows(tx, sql`DELETE FROM ${sql.raw(qualified(t))} WHERE ${sql.raw(key)} = ${target.id}::uuid RETURNING 1`),
      ),
    );
  }
  const probe = await addUser(w(), 'write probe');
  await attempt(() =>
    asApp(w(), ctx, (tx) =>
      (tx as unknown as Wall['app']).insert(table(w().identity, 'member')).values({
        id: randomUUID(),
        organizationId: target.id,
        userId: probe,
        role: 'admin',
        createdAt: new Date(),
      } as never),
    ),
  );
  await attempt(() =>
    asApp(w(), ctx, (tx) =>
      (tx as unknown as Wall['app']).insert(w().grants.auditorGrants!).values({
        id: randomUUID(),
        orgId: target.id,
        userId: probe,
        expiresAt: sql`now() + interval '30 days'`,
        revokedAt: null,
      } as never),
    ),
  );
  expect(await fingerprint(w())).toEqual(before);
}

describe('auditor grants (criterion 3)', () => {
  it('an active grant lets the auditor see all of the audited org’s rows', async () => {
    await expectSees(ctxIn(A, users['active auditor']!), B, 'active grant');
  });

  it('an active grant shows only the auditor’s own org and the audited org', async () => {
    await expectSeesOnly(ctxIn(A, users['active auditor']!), [A, B], 'active grant');
  });

  it('an active grant is read-only: no update, delete or insert in the audited org', async () => {
    await expectCannotWrite(ctxIn(A, users['active auditor']!), B);
  });

  it('the grant belongs to the auditor only: another user in the same org sees nothing of B', async () => {
    await expectSeesNone(adminCtx(A), B, 'admin of A');
    await expectSeesNone(ctxIn(A, users['auditor without grant']!), B, 'auditor without grant');
  });

  it('a grant expired by one second shows nothing', async () => {
    await expectSeesNone(ctxIn(A, users['expired auditor']!), B, 'expired grant');
  });

  it('a grant revoked one second ago shows nothing', async () => {
    await expectSeesNone(ctxIn(A, users['revoked auditor']!), B, 'revoked grant');
  });

  it('app_visible_org follows the grant', async () => {
    const { sql } = w().loaded;
    const check = async (label: string): Promise<boolean> => {
      const [r] = await asApp(w(), ctxIn(A, users[label]!), (tx) =>
        rows<{ v: boolean }>(tx, sql`SELECT app_visible_org(${B.id}::uuid) AS v`),
      );
      return r!.v;
    };
    expect(await check('active auditor')).toBe(true);
    expect(await check('expired auditor')).toBe(false);
    expect(await check('revoked auditor')).toBe(false);
    expect(await check('auditor without grant')).toBe(false);
  });
});

describe('parent links (criterion 4)', () => {
  it('an approved link lets the parent see the subsidiary’s rows', async () => {
    await expectSees(adminCtx(P), S, 'approved link');
  });

  it('the approved link is read-only for the parent', async () => {
    await expectCannotWrite(adminCtx(P), S);
  });

  it('a requested but unapproved link gives nothing', async () => {
    await expectSeesNone(adminCtx(P), R, 'requested link');
  });

  it('an ended link gives nothing', async () => {
    await expectSeesNone(adminCtx(P), E, 'ended link');
  });

  it('the parent sees only itself and its approved subsidiary', async () => {
    await expectSeesOnly(adminCtx(P), [P, S], 'parent');
  });

  it('the link works one way: the subsidiary sees nothing of the parent', async () => {
    await expectSeesNone(adminCtx(S), P, 'subsidiary');
    await expectSeesOnly(adminCtx(S), [S], 'subsidiary');
  });
});

describe('break-glass sessions (D55)', () => {
  it('an open session lets the operator see the org’s rows', async () => {
    await expectSees(ctxIn(A, users['open operator']!, 'viewer'), B, 'open session');
  });

  it('an open session is read-only', async () => {
    await expectCannotWrite(ctxIn(A, users['open operator']!, 'viewer'), B);
  });

  it('an open session shows no third org', async () => {
    await expectSeesNone(ctxIn(A, users['open operator']!, 'viewer'), C, 'open session');
  });

  it('a session expired by one second gives nothing', async () => {
    await expectSeesNone(ctxIn(A, users['expired operator']!, 'viewer'), B, 'expired session');
  });

  it('a session ended one second ago gives nothing', async () => {
    await expectSeesNone(ctxIn(A, users['ended operator']!, 'viewer'), B, 'ended session');
  });
});
