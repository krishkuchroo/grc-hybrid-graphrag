// S1-004 criterion 7 (D37, D48, D56, D186): after a create, update and retire through the routes,
// the Postgres audit trail has the three entries (`record.created`, `record.updated`,
// `record.retired`) with `meta { number, label }` within 5 s, copied by the worker's relay. The
// actor is the person (`user`), or the key (`api_key`) for a request made with an API key (D54).
// The worker program runs against this file's throwaway database, as in the M0-013 worker test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../auth/helpers.js';
import { createKey, type NewKey } from '../api-keys/helpers.js';
import { waitFor } from '../platform/helpers.js';
import {
  LONG,
  T,
  createR,
  fieldChange,
  json,
  newApiOrg,
  patchR,
  person,
  retireR,
  setUpRecordsApi,
  show,
  tearDownRecordsApi,
  validInput,
  type ApiEnv,
  type Org,
  type RecordOut,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let admin: SignedIn;
let key: NewKey;

beforeAll(async () => {
  env = await setUpRecordsApi({ worker: true });
  org = await newApiOrg(env, 'Records Api Audit');
  admin = await person(env, org, 'admin', 'restricted');
  key = await createKey(env.app, admin, { role: 'risk_manager', name: 'audit key' });
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

interface Row {
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  meta: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function rowsFor(id: string): Promise<Row[]> {
  return q<Row>(
    e().k,
    `SELECT action, actor_type, actor_id, target_type, target_id, meta, before, after
     FROM audit_events WHERE org_id = $1 AND target_id = $2 ORDER BY seq`,
    [org.id, id],
  );
}

describe('criterion 7: create, update and retire reach the Postgres audit trail within 5 s', { timeout: T }, () => {
  it('a person: three entries with meta { number, label }, actor user', async () => {
    const created = await createR(e(), admin, 'risk', validInput('risk', { label: 'confidential' }));
    expect(created.statusCode, show(created)).toBe(201);
    const rec = json(created) as unknown as RecordOut;
    const updated = await patchR(e(), admin, 'risk', rec.id, { ...fieldChange('risk'), version: 1 });
    expect(updated.statusCode, show(updated)).toBe(200);
    const retired = await retireR(e(), admin, 'risk', rec.id, 2);
    expect(retired.statusCode, show(retired)).toBe(200);

    const found = await waitFor(
      'the three audit entries in Postgres',
      async () => {
        const r = await rowsFor(rec.id);
        return r.length >= 3 ? r : undefined;
      },
      5000,
    );
    expect(found.map((r) => r.action)).toEqual(['record.created', 'record.updated', 'record.retired']);
    for (const row of found) {
      expect(row).toMatchObject({
        actor_type: 'user',
        actor_id: admin.user.id,
        target_type: 'risk',
        target_id: rec.id,
      });
      expect(row.meta).toEqual({ number: rec.number, label: 'confidential' });
    }
    expect(found[1]!.before).toEqual({ impact: rec.impact });
    expect(found[1]!.after).toEqual(fieldChange('risk'));
    expect(found[2]!.after).toEqual({ status: 'retired' });
  });

  it('an API key: the entries name the key as the actor (api_key)', async () => {
    const created = await createR(e(), key, 'risk', validInput('risk', { label: 'internal', owner: admin.user.id }));
    expect(created.statusCode, show(created)).toBe(201);
    const rec = json(created) as unknown as RecordOut;
    const updated = await patchR(e(), key, 'risk', rec.id, { ...fieldChange('risk'), version: 1 });
    expect(updated.statusCode, show(updated)).toBe(200);
    const retired = await retireR(e(), key, 'risk', rec.id, 2);
    expect(retired.statusCode, show(retired)).toBe(200);

    const found = await waitFor(
      'the key audit entries in Postgres',
      async () => {
        const r = await rowsFor(rec.id);
        return r.length >= 3 ? r : undefined;
      },
      5000,
    );
    expect(found.map((r) => r.action)).toEqual(['record.created', 'record.updated', 'record.retired']);
    for (const row of found) {
      expect(row).toMatchObject({ actor_type: 'api_key', actor_id: key.id });
      expect(row.meta).toEqual({ number: rec.number, label: 'internal' });
    }
  });
});
