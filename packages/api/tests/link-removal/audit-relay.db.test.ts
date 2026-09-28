// S1-011 criterion 5 (D201, D37, D48, D56, D186, D54): a removal's `link.removed` entry reaches the
// Postgres audit trail through the worker's relay within 5 s, with `actorType` `user` for a person
// and `api_key` for an API key, `before` holding the full copy of the link, `after` null and `meta`
// with the higher label. It pairs with the link's `link.created` entry (the same target).
// The worker runs against this file's throwaway Postgres database, as in S1-004's audit-relay test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  body,
  createKey,
  json,
  makeRecord,
  newLinksOrg,
  person,
  postLink,
  relayed,
  removeLink,
  removeWithKey,
  removed,
  seedLink,
  setUpRemoval,
  show,
  targetIdOf,
  tearDownRemoval,
  type NewKey,
  type Person,
  type RemovalEnv,
} from './helpers.js';

let env: RemovalEnv;
let orgId: string;
let admin: Person;
let key: NewKey;

beforeAll(async () => {
  env = await setUpRemoval({ worker: true });
  const org = await newLinksOrg(env, 'Link Removal Relay');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  key = await createKey(env.app, admin.signedIn, { role: 'risk_manager', name: 'relay key' });
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

describe('criterion 5: link.removed reaches the Postgres audit trail within 5 s', () => {
  it(
    'a person: actor user, the full copy in before, after null, meta with the higher label, paired with link.created',
    async () => {
      const risk = await makeRecord(env, admin, 'risk', { label: 'restricted' });
      const control = await makeRecord(env, admin, 'control', { label: 'internal' });
      const created = await postLink(env, admin, body('MITIGATED_BY', risk, control));
      expect(created.statusCode, show(created)).toBe(201);
      const link = json(created) as { createdAt: string; createdBy: string };
      removed(await removeLink(env, admin, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));

      const target = await targetIdOf('MITIGATED_BY', risk.id, control.id);
      const row = await relayed(env, orgId, 'link.removed', target);
      const createdRow = await relayed(env, orgId, 'link.created', target);
      expect(row).toMatchObject({ actor_type: 'user', actor_id: admin.id, target_type: 'link', target_id: target });
      expect(createdRow.target_id).toBe(row.target_id);
      expect(row.before).toEqual({
        type: 'MITIGATED_BY',
        fromId: risk.id,
        toId: control.id,
        fromNumber: risk.number,
        toNumber: control.number,
        createdAt: link.createdAt,
        createdBy: link.createdBy,
        origin: 'manual',
      });
      expect(row.after).toBeNull();
      expect(row.meta).toEqual({
        type: 'MITIGATED_BY',
        fromNumber: risk.number,
        toNumber: control.number,
        label: 'restricted',
      });
    },
    T,
  );

  it(
    'an API key: actor api_key, the key ID',
    async () => {
      const risk = await makeRecord(env, admin, 'risk', { label: 'internal' });
      const control = await makeRecord(env, admin, 'control', { label: 'public' });
      const seeded = await seedLink(env, orgId, 'MITIGATED_BY', risk, control, {
        origin: 'import',
        createdBy: 'importer',
      });
      removed(await removeWithKey(env, key, body('MITIGATED_BY', risk, control)), body('MITIGATED_BY', risk, control));
      const row = await relayed(env, orgId, 'link.removed', await targetIdOf('MITIGATED_BY', risk.id, control.id));
      expect(row).toMatchObject({ actor_type: 'api_key', actor_id: key.id, target_type: 'link' });
      expect(row.before).toEqual({
        type: 'MITIGATED_BY',
        fromId: risk.id,
        toId: control.id,
        fromNumber: risk.number,
        toNumber: control.number,
        createdAt: seeded.createdAt,
        createdBy: 'importer',
        origin: 'import',
      });
      expect(row.meta).toEqual({
        type: 'MITIGATED_BY',
        fromNumber: risk.number,
        toNumber: control.number,
        label: 'internal',
      });
    },
    T,
  );
});
