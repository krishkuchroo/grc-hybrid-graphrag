// S1-011 criterion 9 (D163, D164, SF-006): a failing removal logs only the error type or code, the
// reference ID and IDs, never record names or the copy of the link. Each test forces a failure
// whose error quotes a sentinel (the way a Neo4j error quotes values), or gives the records and the
// link sentinel values, and checks that no sentinel is in the log or the answer, while the log line
// still carries the answer's reference ID, the method and the URL.
// Failures are forced by wrapping, for one request, the app's own objects: the AuditOutbox (a write
// that fails after the removal ran) and the GraphService (a read that fails). Each is put back after.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  REMOVE,
  T,
  appGraph,
  body,
  linkCount,
  makeRecord,
  newLinksOrg,
  person,
  refusal,
  removeLink,
  seedLink,
  setUpRemoval,
  tearDownRemoval,
  type InjectResponse,
  type Person,
  type Rec,
  type RemovalEnv,
} from './helpers.js';

let env: RemovalEnv;
let orgId: string;
let admin: Person;
let viewer: Person;
let viewerInternal: Person;

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal Logs');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  viewer = await person(env, org, 'viewer', 'restricted');
  viewerInternal = await person(env, org, 'viewer', 'internal');
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

class SentinelFailure extends Error {
  constructor(sentinel: string) {
    super(`Relationship between (:Risk {name: '${sentinel}'}) and (:Control) could not be deleted`);
    this.name = 'SentinelFailure';
  }
}

function sentinel(): string {
  return `SENTINEL-${randomUUID()}`;
}

/** A risk and a control named with sentinels, and a link between them made by a sentinel creator. */
async function sentinelLink(origin: 'manual' | 'ai' = 'manual', label: 'internal' | 'confidential' = 'internal') {
  const names = { risk: sentinel(), control: sentinel(), creator: sentinel() };
  const risk: Rec = await makeRecord(env, admin, 'risk', { label: 'internal', extra: { name: names.risk } });
  const control: Rec = await makeRecord(env, admin, 'control', { label, extra: { name: names.control } });
  await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { origin, createdBy: names.creator });
  return { risk, control, secrets: Object.values(names) };
}

/** Replaces `obj[name]` for the length of `fn`, then puts it back. */
async function patched<R>(obj: object, name: string, replacement: unknown, fn: () => Promise<R>): Promise<R> {
  const target = obj as Record<string, unknown>;
  const own = Object.hasOwn(target, name);
  const original = target[name];
  target[name] = replacement;
  try {
    return await fn();
  } finally {
    if (own) target[name] = original;
    else delete target[name];
  }
}

function expectNoSecrets(res: InjectResponse, secrets: string[]): void {
  for (const s of secrets) {
    expect(res.body, 'the answer holds no record value').not.toContain(s);
    expect(
      env.logs.lines.filter((line) => line.includes(s)),
      'log lines holding a record name or the link copy',
    ).toEqual([]);
  }
}

/** The 500 answer's reference ID is in a log line with the method and URL, and no stack. */
function expectCleanFailure(res: InjectResponse, secrets: string[]): void {
  const r = refusal(res, 500);
  expectNoSecrets(res, secrets);
  const referenceId = (JSON.parse(res.body) as { error: { referenceId: string } }).error.referenceId;
  const lines = env.logs.lines.filter((line) => line.includes(referenceId));
  expect(lines.length, `a log line carries the reference ID (${r.code})`).toBeGreaterThan(0);
  const line = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  expect(line['method']).toBe('POST');
  expect(line['url']).toBe(REMOVE);
  expect(lines.join('\n'), 'no stack trace in the log line').not.toContain('"stack"');
}

describe('criterion 9: a failing removal logs no record values (D163, D164)', () => {
  it(
    'a failed audited write quoting a record name: 500, the link stays, nothing leaks',
    async () => {
      const { risk, control, secrets } = await sentinelLink();
      const { AuditOutbox } = await import('../../src/audit/outbox.js');
      const outbox = env.app.get<{ withAuditedWrite: (...a: unknown[]) => Promise<unknown> }>(AuditOutbox);
      const real = outbox.withAuditedWrite.bind(outbox);
      const failing = (org: unknown, actor: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        real(org, actor, async (tx: unknown) => {
          await fn(tx);
          throw new SentinelFailure(secrets[0]!);
        });
      const res = await patched(outbox, 'withAuditedWrite', failing, () =>
        removeLink(env, admin, body('MITIGATED_BY', risk, control)),
      );
      expectCleanFailure(res, secrets);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
    },
    T,
  );

  it(
    'a failed graph read quoting a record name: 500, nothing leaks',
    async () => {
      const { risk, control, secrets } = await sentinelLink();
      const graph = (await appGraph(env)) as unknown as object;
      const fail = async () => {
        throw new SentinelFailure(secrets[0]!);
      };
      const res = await patched(graph, 'readAs', fail, () =>
        patched(graph, 'read', fail, () => removeLink(env, admin, body('MITIGATED_BY', risk, control))),
      );
      expectCleanFailure(res, secrets);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
    },
    T,
  );

  it.each([
    ['403 (a Viewer)', 'manual', 'internal', 403] as const,
    ['404 (an end above the clearance)', 'manual', 'confidential', 404] as const,
    ['409 (an ai link)', 'ai', 'internal', 409] as const,
  ])(
    'a refused removal, %s: no record name or link copy in the log or the answer',
    async (_what, origin, label, status) => {
      const { risk, control, secrets } = await sentinelLink(origin, label);
      const who = status === 403 ? viewer : status === 404 ? viewerInternal : admin;
      const res = await removeLink(env, who, body('MITIGATED_BY', risk, control));
      refusal(res, status);
      expectNoSecrets(res, secrets);
    },
    T,
  );
});
