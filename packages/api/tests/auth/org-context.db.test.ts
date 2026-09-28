// M0-010 criterion 6 (D4, D55, D59), for every ordered pair of three orgs.
// 6. A user in org A can't make any request run in org B's context, including by sending another
//    org ID in a header or body.
// The request's context is `request.principal` (set by the SessionGuard from the session and the
// member row); the probe controller echoes it. From M0-009's security review: before using
// `session.active_organization_id`, the guard checks that the user is a member of that org.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH,
  ME,
  PROBE,
  call,
  json,
  mfaUser,
  q,
  seedOrg,
  setUpAuth,
  show,
  tearDownAuth,
  type AuthEnv,
  type Org,
  type SignedIn,
} from './helpers.js';

let env: AuthEnv | undefined;
const orgs: Org[] = [];
const people = new Map<string, SignedIn>(); // org id -> a signed-in admin of that org

beforeAll(async () => {
  env = await setUpAuth();
  for (const name of ['Org A', 'Org B', 'Org C']) {
    const org = await seedOrg(env.k, name);
    orgs.push(org);
  }
}, 180_000);

afterAll(async () => {
  await tearDownAuth(env);
});

function e(): AuthEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

async function person(org: Org): Promise<SignedIn> {
  let p = people.get(org.id);
  if (!p) {
    p = await mfaUser(e().k, e().app, org, { role: 'admin', clearance: 'restricted' });
    people.set(org.id, p);
  }
  return p;
}

type Pair = { from: number; to: number; label: string };
const PAIRS: Pair[] = [];
for (let a = 0; a < 3; a++) {
  for (let b = 0; b < 3; b++) {
    if (a !== b) PAIRS.push({ from: a, to: b, label: `${'ABC'[a]} -> ${'ABC'[b]}` });
  }
}

const ORG_HEADERS = ['x-org-id', 'x-organization-id', 'x-active-organization-id', 'org-id', 'x-tenant-id'];

async function principalOrg(res: Awaited<ReturnType<typeof call>>): Promise<string | undefined> {
  expect(res.statusCode, show(res)).toBe(200);
  const p = (json(res).principal ?? null) as { orgId?: string } | null;
  return p?.orgId;
}

describe('criterion 6: the org comes from the session, never from the request', () => {
  it.each(PAIRS)('$label: a signed-in request runs in its own org', async ({ from }) => {
    const a = await person(orgs[from]!);
    expect(await principalOrg(await call(e().app, a.jar, { url: `${PROBE}/whoami` }))).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)("$label: another org's ID in the headers is ignored", async ({ from, to }) => {
    const a = await person(orgs[from]!);
    const headers = Object.fromEntries(ORG_HEADERS.map((h) => [h, orgs[to]!.id]));
    expect(await principalOrg(await call(e().app, a.jar, { url: `${PROBE}/whoami`, headers }))).toBe(orgs[from]!.id);
    const me = await call(e().app, a.jar, { url: ME, headers });
    expect(me.statusCode, show(me)).toBe(200);
    expect((json(me).org as { id?: string }).id).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)("$label: another org's ID in the body or query is ignored", async ({ from, to }) => {
    const a = await person(orgs[from]!);
    const b = orgs[to]!.id;
    const res = await call(e().app, a.jar, {
      method: 'POST',
      url: `${PROBE}/whoami?orgId=${b}&organizationId=${b}`,
      payload: { orgId: b, organizationId: b, org_id: b, activeOrganizationId: b },
    });
    expect(res.statusCode, show(res)).toBeLessThan(300);
    const p = (json(res).principal ?? null) as { orgId?: string } | null;
    expect(p?.orgId).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)("$label: switching the active org to one the user isn't a member of fails", async ({ from, to }) => {
    const a = await person(orgs[from]!);
    const res = await call(e().app, a.jar, {
      method: 'POST',
      url: `${AUTH}/organization/set-active`,
      payload: { organizationId: orgs[to]!.id },
    });
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    expect(await principalOrg(await call(e().app, a.jar, { url: `${PROBE}/whoami` }))).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)(
    '$label: a session whose active org was changed underneath to a non-member org is never run in that org',
    async ({ from, to }) => {
      const p = await mfaUser(e().k, e().app, orgs[from]!, { role: 'viewer' });
      await q(e().k, `UPDATE "session" SET active_organization_id = $1 WHERE user_id = $2`, [orgs[to]!.id, p.user.id]);
      for (const url of [`${PROBE}/whoami`, ME]) {
        const res = await call(e().app, p.jar, { url });
        if (res.statusCode === 200) {
          const body = json(res);
          const seen = url === ME ? (body.org as { id?: string }).id : (body.principal as { orgId?: string }).orgId;
          expect(seen, `${url}: ${show(res)}`).toBe(orgs[from]!.id);
        } else {
          expect([401, 403], `${url}: ${show(res)}`).toContain(res.statusCode);
        }
      }
    },
  );
});

describe('criterion 6: membership is checked on every request', () => {
  it('a user removed from their org loses access at once', async () => {
    const p = await mfaUser(e().k, e().app, orgs[0]!, { role: 'viewer' });
    expect((await call(e().app, p.jar, { url: `${PROBE}/whoami` })).statusCode).toBe(200);
    await q(e().k, `DELETE FROM "member" WHERE user_id = $1`, [p.user.id]);
    for (const url of [`${PROBE}/whoami`, ME]) {
      const res = await call(e().app, p.jar, { url });
      expect([401, 403], `${url}: ${show(res)}`).toContain(res.statusCode);
    }
  });

  it('a user moved to another org is never run in the old one', async () => {
    const p = await mfaUser(e().k, e().app, orgs[0]!, { role: 'viewer' });
    await q(e().k, `UPDATE "member" SET org_id = $1 WHERE user_id = $2`, [orgs[1]!.id, p.user.id]);
    const res = await call(e().app, p.jar, { url: `${PROBE}/whoami` });
    if (res.statusCode === 200) {
      expect((json(res).principal as { orgId?: string }).orgId).not.toBe(orgs[0]!.id);
    } else {
      expect([401, 403], show(res)).toContain(res.statusCode);
    }
  });
});
