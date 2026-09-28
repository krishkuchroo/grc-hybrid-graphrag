// M0-011 criterion 5 (D54, D56: permission changes and failures are logged).
// 5. Create, revoke and each refused use write audit events.
// Event names (helpers.ts): `api_key.created` and `api_key.revoked` by the Admin (actor_type `user`),
// `api_key.refused` by the key (actor_type `api_key`, actor_id the key ID), one per refused request
// of an expired or revoked key. All go to the key's own org, and none holds the plain key.
// A key that matches nothing has no org: it is logged in the API's own log, not in any org chain.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  advance,
  allAuditText,
  freezeClock,
  realClock,
  seedOrg,
  show,
  type Org,
} from '../auth/helpers.js';
import {
  admin,
  createKey,
  forbiddenForms,
  keyAuditDuring,
  mustRevoke,
  onlyKeyEvents,
  setUpKeys,
  tearDownKeys,
  useKey,
  type KeyAuditRow,
  type KeyEnv,
  type NewKey,
} from './helpers.js';

let env: KeyEnv | undefined;
let org: Org;
let bystander: Org;

beforeAll(async () => {
  env = await setUpKeys();
  org = await seedOrg(env.k, 'Keys Audit Org');
  bystander = await seedOrg(env.k, 'Keys Audit Bystander Org');
}, 180_000);

afterAll(async () => {
  realClock();
  await tearDownKeys(env);
});

afterEach(() => realClock());

function e(): KeyEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

function actions(list: KeyAuditRow[]): string[] {
  return list.map((ev) => ev.action);
}

describe('criterion 5: create and revoke are audited', () => {
  it('creating a key writes one api_key.created by the Admin, about the key', async () => {
    const a = await admin(e().k, e().app, org);
    let made: NewKey | undefined;
    const added = await keyAuditDuring(e().k, org.id, async () => {
      made = await createKey(e().app, a, { role: 'analyst', name: 'audited-create' });
    });
    const events = onlyKeyEvents(added);
    expect(actions(events)).toEqual(['api_key.created']);
    expect(events[0]).toMatchObject({
      actor_type: 'user',
      actor_id: a.user.id,
      target_type: 'api_key',
      target_id: made!.id,
    });
    for (const form of forbiddenForms(made!.key)) expect(events[0]!.text).not.toContain(form);
  });

  it('revoking a key writes one api_key.revoked by the Admin, about the key', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    const added = await keyAuditDuring(e().k, org.id, () => mustRevoke(e().app, a, made.id));
    const events = onlyKeyEvents(added);
    expect(actions(events)).toEqual(['api_key.revoked']);
    expect(events[0]).toMatchObject({
      actor_type: 'user',
      actor_id: a.user.id,
      target_type: 'api_key',
      target_id: made.id,
    });
  });

  it("events go to the key's own org only", async () => {
    const a = await admin(e().k, e().app, org);
    const inOther = await keyAuditDuring(e().k, bystander.id, async () => {
      const made = await createKey(e().app, a);
      await mustRevoke(e().app, a, made.id);
      await useKey(e().app, made);
    });
    expect(inOther).toEqual([]);
  });

  it('a successful use writes no refusal', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    const added = await keyAuditDuring(e().k, org.id, async () => {
      const res = await useKey(e().app, made);
      expect(res.statusCode, show(res)).toBe(200);
    });
    expect(actions(added)).not.toContain('api_key.refused');
  });
});

describe('criterion 5: each refused use is audited', () => {
  it('each request with a revoked key writes one api_key.refused by the key', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    await mustRevoke(e().app, a, made.id);
    const added = await keyAuditDuring(e().k, org.id, async () => {
      for (let i = 0; i < 3; i++) expect((await useKey(e().app, made)).statusCode).toBe(401);
    });
    const events = onlyKeyEvents(added);
    expect(actions(events)).toEqual(['api_key.refused', 'api_key.refused', 'api_key.refused']);
    for (const ev of events) {
      expect(ev.actor_type, ev.text).toBe('api_key');
      expect(ev.actor_id, ev.text).toBe(made.id);
    }
  });

  it('each request with an expired key writes one api_key.refused by the key', async () => {
    freezeClock();
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    advance(HOUR + MINUTE);
    const added = await keyAuditDuring(e().k, org.id, async () => {
      for (let i = 0; i < 2; i++) expect((await useKey(e().app, made)).statusCode).toBe(401);
    });
    const events = onlyKeyEvents(added);
    expect(actions(events)).toEqual(['api_key.refused', 'api_key.refused']);
    for (const ev of events) {
      expect(ev.actor_type, ev.text).toBe('api_key');
      expect(ev.actor_id, ev.text).toBe(made.id);
    }
  });

  it('a key that matches nothing is logged in the API log, and writes nothing into any org chain', async () => {
    const unknown = `grc_${'Q'.repeat(20)}unknown${'z'.repeat(20)}`;
    const before = e().logs.lines.length;
    let inOther: KeyAuditRow[] = [];
    const inOrg = await keyAuditDuring(e().k, org.id, async () => {
      inOther = await keyAuditDuring(e().k, bystander.id, async () => {
        expect((await useKey(e().app, unknown)).statusCode).toBe(401);
      });
    });
    expect(inOrg).toEqual([]);
    expect(inOther).toEqual([]);
    const lines = e()
      .logs.lines.slice(before)
      .filter((l) => l.includes('api_key.refused'));
    expect(lines.length, 'one log line for the refused key').toBe(1);
    expect(lines[0]).not.toContain(unknown);
  });

  it('no audit event and no log line ever holds a plain key', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    await useKey(e().app, made);
    await mustRevoke(e().app, a, made.id);
    await useKey(e().app, made);
    const audit = await allAuditText(e().k);
    const logs = e().logs.lines.join('\n');
    for (const form of forbiddenForms(made.key)) {
      expect(audit).not.toContain(form);
      expect(logs).not.toContain(form);
    }
  });
});
