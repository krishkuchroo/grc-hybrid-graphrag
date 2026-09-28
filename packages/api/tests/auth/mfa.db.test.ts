// M0-010 criterion 2 (D49, D54) and the SessionGuard from the brief's "Interfaces".
// 2. MFA with TOTP and backup codes. No route beyond the allowed list works before MFA is set up
//    and checked.
// SessionGuard (global): every route except /api/v1/auth/* and /api/v1/health needs a session with
// MFA completed. A signed-in user without MFA gets 403 `mfa_required` on everything except the 2FA
// setup routes and /api/v1/me.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  AUTH,
  AUTH_LOOKALIKE,
  HEALTH_LOOKALIKE,
  ME,
  PREFIX,
  PROBE,
  Jar,
  call,
  enrol,
  errorCode,
  json,
  mfaUser,
  seedOrg,
  seedUser,
  setUpAuth,
  show,
  signInFull,
  signInPassword,
  tearDownAuth,
  totpFromUri,
  totpNow,
  wantsSecondFactor,
  wrongCode,
  type AuthEnv,
  type Org,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Mfa Org');
}, 180_000);

afterAll(async () => {
  await tearDownAuth(env);
});

function e(): AuthEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

function expectMfaRequired(res: Awaited<ReturnType<typeof call>>): void {
  const body = expectErrorFormat(res, 403);
  expect(body.error.code).toBe('mfa_required');
}

describe('with no session', () => {
  it.each([
    ['GET', PROBE + '/whoami'],
    ['POST', PROBE + '/whoami'],
    ['GET', ME],
    ['GET', `${PREFIX}/openapi.json`],
    ['GET', AUTH_LOOKALIKE + '/whoami'],
    ['GET', HEALTH_LOOKALIKE + '/whoami'],
  ])('%s %s is refused with 401 in the error format', async (method, url) => {
    const res = await call(e().app, undefined, { method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    expectErrorFormat(res, 401);
  });

  it('a made-up session cookie is refused with 401', async () => {
    const jar = new Jar();
    jar.absorb({
      statusCode: 200,
      headers: {
        'set-cookie': ['better-auth.session_token=forged.value', '__Secure-better-auth.session_token=forged.value'],
      },
      body: '',
      json: () => ({}),
    });
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
  });

  it('GET /api/v1/health stays open', async () => {
    const res = await call(e().app, undefined, { url: `${PREFIX}/health` });
    expect(res.statusCode, show(res)).toBe(200);
  });

  it('the sign-in route under /api/v1/auth stays open', async () => {
    const res = await signInPassword(e().app, new Jar(), 'nobody@x.test', 'not-the-password-123');
    expect(res.statusCode, show(res)).not.toBe(404);
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, show(res)).toBeLessThan(500);
  });
});

describe('signed in with a password but no MFA yet', () => {
  let jar: Jar;
  let password: string;

  beforeAll(async () => {
    const user = await seedUser(e().k, org, { role: 'admin', clearance: 'restricted' });
    password = user.password;
    jar = new Jar();
    const res = await signInPassword(e().app, jar, user.email, user.password);
    if (res.statusCode !== 200) throw new Error(`sign-in failed: ${show(res)}`);
  });

  it('GET /api/v1/me works and says mfaEnrolled: false', async () => {
    const res = await call(e().app, jar, { url: ME });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(res).mfaEnrolled).toBe(false);
  });

  it.each([
    ['GET', PROBE + '/whoami'],
    ['POST', PROBE + '/whoami'],
    ['GET', `${PREFIX}/openapi.json`],
    ['GET', AUTH_LOOKALIKE + '/whoami'],
  ])('%s %s gets 403 mfa_required', async (method, url) => {
    expectMfaRequired(await call(e().app, jar, { method, url, ...(method === 'POST' ? { payload: {} } : {}) }));
  });

  it.each([
    ['POST', `${AUTH}/change-password`, { currentPassword: 'x', newPassword: 'Another-long-password-1' }],
    ['GET', `${AUTH}/list-sessions`, undefined],
    ['POST', `${AUTH}/update-user`, { name: 'Renamed' }],
    ['POST', `${AUTH}/organization/set-active`, { organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['GET', `${AUTH}/organization/list`, undefined],
  ])('Better Auth route %s %s gets 403 mfa_required (not a 2FA setup route)', async (method, url, payload) => {
    expectMfaRequired(await call(e().app, jar, { method, url, ...(payload ? { payload } : {}) }));
  });

  it('two-factor/enable alone (no code checked yet) does not open the routes', async () => {
    const res = await call(e().app, jar, { method: 'POST', url: `${AUTH}/two-factor/enable`, payload: { password } });
    expect(res.statusCode, show(res)).toBe(200);
    const body = json(res) as { totpURI?: string; backupCodes?: string[] };
    expect(typeof body.totpURI).toBe('string');
    expect(Array.isArray(body.backupCodes) && body.backupCodes.length > 0, 'backup codes are handed out').toBe(true);
    expectMfaRequired(await call(e().app, jar, { url: `${PROBE}/whoami` }));
    expect(json(await call(e().app, jar, { url: ME })).mfaEnrolled).toBe(false);

    const t = totpFromUri(body.totpURI!);
    const wrong = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-totp`,
      payload: { code: wrongCode(t) },
    });
    expect(wrong.statusCode, show(wrong)).toBeGreaterThanOrEqual(400);
    expectMfaRequired(await call(e().app, jar, { url: `${PROBE}/whoami` }));

    const right = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-totp`,
      payload: { code: totpNow(t) },
    });
    expect(right.statusCode, show(right)).toBe(200);
    const probe = await call(e().app, jar, { url: `${PROBE}/whoami` });
    expect(probe.statusCode, show(probe)).toBe(200);
    expect(json(await call(e().app, jar, { url: ME })).mfaEnrolled).toBe(true);
  });
});

describe('an enrolled user signing in', () => {
  it('the password alone gives no session: sign-in asks for the second factor', async () => {
    const { user } = await mfaUser(e().k, e().app, org);
    const jar = new Jar();
    const res = await signInPassword(e().app, jar, user.email, user.password);
    expect(wantsSecondFactor(res), show(res)).toBe(true);
    expectErrorFormat(await call(e().app, jar, { url: ME }), 401);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
  });

  it('a wrong TOTP code gives no session', async () => {
    const { user, mfa } = await mfaUser(e().k, e().app, org);
    const jar = new Jar();
    expect(wantsSecondFactor(await signInPassword(e().app, jar, user.email, user.password))).toBe(true);
    const res = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-totp`,
      payload: { code: wrongCode(mfa.totp) },
    });
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
  });

  it('password plus the right TOTP code opens the routes', async () => {
    const { user, mfa } = await mfaUser(e().k, e().app, org);
    const jar = await signInFull(e().app, user, mfa);
    const res = await call(e().app, jar, { url: `${PROBE}/whoami` });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(await call(e().app, jar, { url: ME })).mfaEnrolled).toBe(true);
  });

  it('a backup code works once instead of the TOTP code, and not a second time', async () => {
    const { user, mfa } = await mfaUser(e().k, e().app, org);
    expect(mfa.backupCodes.length).toBeGreaterThan(0);
    const code = mfa.backupCodes[0]!;

    const jar = new Jar();
    expect(wantsSecondFactor(await signInPassword(e().app, jar, user.email, user.password))).toBe(true);
    const ok = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-backup-code`,
      payload: { code },
    });
    expect(ok.statusCode, show(ok)).toBe(200);
    expect((await call(e().app, jar, { url: `${PROBE}/whoami` })).statusCode).toBe(200);

    const again = new Jar();
    expect(wantsSecondFactor(await signInPassword(e().app, again, user.email, user.password))).toBe(true);
    const reused = await call(e().app, again, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-backup-code`,
      payload: { code },
    });
    expect(reused.statusCode, show(reused)).toBeGreaterThanOrEqual(400);
    expectErrorFormat(await call(e().app, again, { url: `${PROBE}/whoami` }), 401);
  });

  it('"trust this device" does not let a later sign-in skip the second factor (MFA for everyone, D54)', async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    const jar = new Jar();
    expect(wantsSecondFactor(await signInPassword(e().app, jar, user.email, user.password))).toBe(true);
    const verified = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/verify-totp`,
      payload: { code: totpNow(mfa.totp), trustDevice: true },
    });
    expect(verified.statusCode, show(verified)).toBe(200);
    await call(e().app, jar, { method: 'POST', url: `${AUTH}/sign-out`, payload: {} });

    const res = await signInPassword(e().app, jar, user.email, user.password);
    expect(wantsSecondFactor(res), `a second sign-in on the "trusted" device: ${show(res)}`).toBe(true);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
  });

  it('an enrolled user cannot turn MFA off', async () => {
    const { user, jar, mfa } = await mfaUser(e().k, e().app, org);
    const res = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/two-factor/disable`,
      payload: { password: user.password },
    });
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    expect(json(await call(e().app, jar, { url: ME })).mfaEnrolled).toBe(true);
    const next = new Jar();
    expect(wantsSecondFactor(await signInPassword(e().app, next, user.email, user.password))).toBe(true);
    await signInFull(e().app, user, mfa);
  });
});

describe('a session from before enrolment', () => {
  it('stays limited after the user enrols on another device: that session never checked MFA', async () => {
    const user = await seedUser(e().k, org);
    const early = new Jar();
    const first = await signInPassword(e().app, early, user.email, user.password);
    expect(first.statusCode, show(first)).toBe(200);
    expectMfaRequired(await call(e().app, early, { url: `${PROBE}/whoami` }));

    await enrol(e().app, user);

    const res = await call(e().app, early, { url: `${PROBE}/whoami` });
    expect([401, 403], `the pre-enrolment session: ${show(res)}`).toContain(res.statusCode);
    if (res.statusCode === 403) expect(errorCode(res)).toBe('mfa_required');
  });
});
