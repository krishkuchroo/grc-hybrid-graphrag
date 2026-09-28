// M0-010 criterion 7 (D10, D50, D51) and the /me shape from the brief's "Interfaces".
// 7. /api/v1/me returns the member's role and clearance.
// GET /api/v1/me returns exactly { user: { id, email, name }, org: { id, name }, role, clearance,
// mfaEnrolled }: nothing from Better Auth's own tables beyond that (M0-009 security review).
// The request's principal (M0-008 contract) carries the same org, user, role and clearance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LABELS,
  ME,
  PROBE,
  ROLES,
  call,
  json,
  mfaUser,
  q,
  seedOrg,
  setUpAuth,
  show,
  tearDownAuth,
  type AuthEnv,
  type Label,
  type Org,
  type Role,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Me Org');
}, 180_000);

afterAll(async () => {
  await tearDownAuth(env);
});

function e(): AuthEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

// Every role, and every clearance at least once (the clearances cycle across the roles), plus
// every clearance with one role.
const CASES: { role: Role; clearance: Label }[] = [
  ...ROLES.map((role, i) => ({ role, clearance: LABELS[i % LABELS.length]! })),
  ...LABELS.map((clearance) => ({ role: 'viewer' as Role, clearance })),
];

describe('criterion 7: /api/v1/me returns the member role and clearance', () => {
  it.each(CASES)('$role with clearance $clearance', async ({ role, clearance }) => {
    const { user, jar } = await mfaUser(e().k, e().app, org, { role, clearance });
    const res = await call(e().app, jar, { url: ME });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(res)).toEqual({
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name },
      role,
      clearance,
      mfaEnrolled: true,
    });

    const probe = await call(e().app, jar, { url: `${PROBE}/whoami` });
    expect(probe.statusCode, show(probe)).toBe(200);
    expect(json(probe).principal).toEqual({ orgId: org.id, userId: user.id, role, clearance });
  });

  it('follows the member row: a changed role and clearance show on the next request', async () => {
    const { user, jar } = await mfaUser(e().k, e().app, org, { role: 'viewer', clearance: 'public' });
    await q(e().k, `UPDATE "member" SET role = 'analyst', clearance = 'confidential' WHERE user_id = $1`, [user.id]);
    const res = await call(e().app, jar, { url: ME });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(res)).toMatchObject({ role: 'analyst', clearance: 'confidential' });
    const probe = await call(e().app, jar, { url: `${PROBE}/whoami` });
    expect(json(probe).principal).toMatchObject({ role: 'analyst', clearance: 'confidential' });
  });

  it('never returns session, account or two-factor data', async () => {
    const { jar } = await mfaUser(e().k, e().app, org);
    const res = await call(e().app, jar, { url: ME });
    const text = res.body;
    const secrets = await q<{ token: string }>(e().k, `SELECT token FROM "session"`);
    for (const s of secrets) expect(text).not.toContain(s.token);
    for (const word of ['token', 'password', 'secret', 'backupCodes', 'backup_codes']) {
      expect(text).not.toContain(word);
    }
  });
});
