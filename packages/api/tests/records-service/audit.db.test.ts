// S1-003 criteria 8 (audit) and 9 (no values in logs): D37, D45.4, D56, D69, D163, D164, D186.
// - Every create, update and retire writes its entry through `withAuditedWrite`, in the same
//   transaction: actions `record.created`, `record.updated`, `record.retired`; `targetType` the
//   kind and `targetId` the record's id; `before` and `after` hold only the changed fields; `meta`
//   holds `{ number, label }`.
// - If the transaction fails, neither the change nor its entry is kept (nor the number it took).
// - The entry reaches the Postgres audit trail through the existing relay, with `actorType`
//   `user` or `api_key`.
// - A failing write logs only the error type or code and the IDs, never names or field values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNumber } from '@grc/shared';
import { auditRows } from '../outbox/helpers.js';
import {
  LONG,
  T,
  caller,
  failingOutbox,
  keyCaller,
  newTestOrg,
  nodeCount,
  outboxEntries,
  refusedWith,
  service,
  setUpRecords,
  spyOutbox,
  storedNode,
  tearDownRecords,
  uniqueName,
  validInput,
  type RecEnv,
  type TestOrg,
} from './helpers.js';

let env: RecEnv;
let org: TestOrg;
let relayOrg: TestOrg; // only the relay test writes here, and its relay pass empties this outbox
let noGraph: TestOrg; // has its Postgres rows and members, but no Neo4j database

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Audit');
  relayOrg = await newTestOrg(env, 'Audit Relay');
  noGraph = await newTestOrg(env, 'Audit No Graph', { graph: false });
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

describe('the audit entry of each change (D56, D69)', { timeout: T }, () => {
  it('create writes one record.created entry with meta { number, label }', async () => {
    const svc = await service(env);
    const input = validInput('risk', { label: 'confidential' });
    const rec = await svc.create(caller(org, 'admin'), 'risk', input);
    const entries = await outboxEntries(env, org.id, rec.id);
    expect(entries.map((e) => e.action)).toEqual(['record.created']);
    const e = entries[0]!;
    expect(e).toMatchObject({ actorType: 'user', actorId: org.adminId, targetType: 'risk', targetId: rec.id });
    expect(e.after?.['name']).toBe(input['name']);
    expect(e.meta).toMatchObject({ number: rec.number, label: 'confidential' });
  });

  it('update writes one record.updated entry with only the changed fields', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk', { impact: 2 }));
    const name = uniqueName('renamed');
    await svc.update(caller(org, 'risk_manager'), 'risk', rec.id, { name, impact: 2, version: 1 });
    const updates = (await outboxEntries(env, org.id, rec.id)).filter((e) => e.action === 'record.updated');
    expect(updates).toHaveLength(1);
    const e = updates[0]!;
    expect(e).toMatchObject({ actorType: 'user', actorId: org.users.byRole.risk_manager, targetType: 'risk' });
    expect(e.before?.['name']).toBe(rec.name);
    expect(e.after?.['name']).toBe(name);
    // impact was sent with its old value, so it didn't change; the other fields weren't sent.
    for (const field of ['impact', 'likelihood', 'financialExposure', 'owner', 'label', 'sensitivity']) {
      expect(Object.keys(e.before ?? {}), `before holds ${field}`).not.toContain(field);
      expect(Object.keys(e.after ?? {}), `after holds ${field}`).not.toContain(field);
    }
    expect(e.meta).toMatchObject({ number: rec.number, label: rec.label });
  });

  it('retire writes one record.retired entry, from active to retired', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'control', validInput('control'));
    await svc.retire(caller(org, 'admin'), 'control', rec.id, 1);
    const retired = (await outboxEntries(env, org.id, rec.id)).filter((e) => e.action === 'record.retired');
    expect(retired).toHaveLength(1);
    const e = retired[0]!;
    expect(e.targetType).toBe('control');
    expect(e.before?.['status']).toBe('active');
    expect(e.after?.['status']).toBe('retired');
    expect(e.meta).toMatchObject({ number: rec.number, label: rec.label });
  });

  it('each change goes through withAuditedWrite once', async () => {
    const outbox = spyOutbox(env.outbox);
    const svc = await service(env, { outbox });
    const rec = await svc.create(caller(org, 'admin'), 'policy', validInput('policy'));
    await svc.update(caller(org, 'admin'), 'policy', rec.id, { policyVersion: '9.9', version: 1 });
    await svc.retire(caller(org, 'admin'), 'policy', rec.id, 2);
    expect(outbox.actors).toEqual([
      { actorType: 'user', actorId: org.adminId },
      { actorType: 'user', actorId: org.adminId },
      { actorType: 'user', actorId: org.adminId },
    ]);
  });

  it("an API key's change is recorded with actorType api_key and the key's ID", async () => {
    const svc = await service(env);
    const who = keyCaller(org, 'risk_manager');
    const rec = await svc.create(who, 'risk', validInput('risk', { owner: org.adminId }));
    const [e] = await outboxEntries(env, org.id, rec.id);
    expect(e).toMatchObject({ actorType: 'api_key', actorId: who.apiKeyId, action: 'record.created' });
  });

  it('a refused change writes no entry', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk'));
    await refusedWith(svc.update(caller(org, 'viewer'), 'risk', rec.id, { impact: 1, version: 1 }), 403, 'forbidden');
    await refusedWith(
      svc.update(caller(org, 'admin'), 'risk', rec.id, { impact: 1, version: 5 }),
      409,
      'stale_version',
    );
    expect((await outboxEntries(env, org.id, rec.id)).map((e) => e.action)).toEqual(['record.created']);
  });
});

describe('one transaction (D45.4)', { timeout: T }, () => {
  it('a failed create keeps neither the record, its entry nor its number', async () => {
    const svc = await service(env);
    const first = await svc.create(caller(org, 'admin'), 'incident', validInput('incident'));
    const broken = await service(env, { outbox: failingOutbox(env.outbox, 'n/a') });
    const input = validInput('incident');
    await expect(broken.create(caller(org, 'admin'), 'incident', input)).rejects.toThrow();
    expect(await nodeCount(env, org.id, 'incident', { name: input['name'] })).toBe(0);
    const all = await outboxEntries(env, org.id);
    expect(all.filter((e) => e.after?.['name'] === input['name'])).toEqual([]);
    const next = await svc.create(caller(org, 'admin'), 'incident', validInput('incident'));
    expect(parseNumber(next.number)?.n).toBe((parseNumber(first.number)?.n ?? 0) + 1);
  });

  it('a failed update keeps neither the change nor its entry', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'asset', validInput('asset'));
    const broken = await service(env, { outbox: failingOutbox(env.outbox, 'n/a') });
    await expect(
      broken.update(caller(org, 'admin'), 'asset', rec.id, { name: uniqueName('lost'), version: 1 }),
    ).rejects.toThrow();
    const node = await storedNode(env, org.id, 'asset', rec.id);
    expect(node?.['name']).toBe(rec.name);
    expect(node?.['version']).toBe(1);
    expect((await outboxEntries(env, org.id, rec.id)).map((e) => e.action)).toEqual(['record.created']);
  });

  it('a failed retire keeps neither the change nor its entry', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'asset', validInput('asset'));
    const broken = await service(env, { outbox: failingOutbox(env.outbox, 'n/a') });
    await expect(broken.retire(caller(org, 'admin'), 'asset', rec.id, 1)).rejects.toThrow();
    expect((await storedNode(env, org.id, 'asset', rec.id))?.['status']).toBe('active');
    expect((await outboxEntries(env, org.id, rec.id)).map((e) => e.action)).toEqual(['record.created']);
  });
});

describe('the relay copies the entries to Postgres (D37)', { timeout: T }, () => {
  it('create, update and retire reach the audit trail with actorType user or api_key', async () => {
    const svc = await service(env);
    const person = caller(relayOrg, 'admin');
    const key = keyCaller(relayOrg, 'admin');
    const rec = await svc.create(person, 'risk', validInput('risk'));
    await svc.update(key, 'risk', rec.id, { impact: 1, version: 1 });
    await svc.retire(person, 'risk', rec.id, 2);

    const { OutboxRelay } = await import('../../src/audit/outbox-relay.job.js');
    const relay = new OutboxRelay({
      graph: env.graph as never,
      audit: env.audit.audit as never,
      orgIds: async () => [relayOrg.id],
      log: env.logger,
    });
    await relay.runOnce();

    const found = (await auditRows({ audit: env.audit } as never, relayOrg.id)).filter((r) => r.targetId === rec.id);
    expect(found.map((r) => [r.action, r.actorType, r.actorId, r.targetType])).toEqual([
      ['record.created', 'user', relayOrg.adminId, 'risk'],
      ['record.updated', 'api_key', key.apiKeyId, 'risk'],
      ['record.retired', 'user', relayOrg.adminId, 'risk'],
    ]);
    for (const r of found) expect(r.meta).toMatchObject({ number: rec.number, label: rec.label });
  });
});

describe('nothing leaks into logs (D163, D164)', { timeout: T }, () => {
  it('a failing update logs the IDs, never the name or the error message', async () => {
    const svc = await service(env);
    const rec = await svc.create(caller(org, 'admin'), 'risk', validInput('risk'));
    const sentinel = `sentinel-name-${uniqueName('leak').replace(/\s+/g, '-')}`;
    const broken = await service(env, { outbox: failingOutbox(env.outbox, sentinel) });
    env.log.lines.length = 0;
    await expect(broken.update(caller(org, 'admin'), 'risk', rec.id, { name: sentinel, version: 1 })).rejects.toThrow();
    const text = env.log.lines.join('\n');
    expect(text, 'a log line about the failed write, naming the record').toContain(rec.id);
    expect(text).not.toContain(sentinel);
  });

  it('a failing create logs the org ID, never the name', async () => {
    const svc = await service(env);
    const sentinel = `sentinel-name-${uniqueName('leak').replace(/\s+/g, '-')}`;
    env.log.lines.length = 0;
    // The org has no Neo4j database, so the write fails.
    await expect(
      svc.create(caller(noGraph, 'admin'), 'risk', validInput('risk', { name: sentinel })),
    ).rejects.toThrow();
    const text = env.log.lines.join('\n');
    expect(text, 'a log line about the failed write, naming the org').toContain(noGraph.id);
    expect(text).not.toContain(sentinel);
  });
});
