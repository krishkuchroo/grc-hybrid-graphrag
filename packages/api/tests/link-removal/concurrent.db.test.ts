// S1-011 criterion 6 (D45.4, D37): two removals of the same link at once. Exactly one gets 200 and
// the other 404 (by then there's no such link), the link is gone, and there's exactly one
// `link.removed` entry. Checked on several links, so no ordering of the two requests passes by luck;
// the outcome is the same whichever request wins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  answered,
  body,
  linkCount,
  makeRecord,
  newLinksOrg,
  outboxEntries,
  person,
  refusal,
  removeLink,
  seedLink,
  setUpRemoval,
  show,
  targetIdOf,
  tearDownRemoval,
  type Person,
  type RemovalEnv,
} from './helpers.js';

let env: RemovalEnv;
let orgId: string;
let admin: Person;
let riskManager: Person;

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal Concurrent');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  riskManager = await person(env, org, 'risk_manager', 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

describe('criterion 6: two removals of the same link at once', () => {
  it.each([1, 2, 3, 4, 5])(
    'round %i: one 200, one 404, one link.removed entry',
    async () => {
      const risk = await makeRecord(env, admin, 'risk', { label: 'internal' });
      const control = await makeRecord(env, admin, 'control', { label: 'internal' });
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { createdBy: admin.id });
      const b = body('MITIGATED_BY', risk, control);
      const [x, y] = await Promise.all([removeLink(env, admin, b), removeLink(env, riskManager, b)]);
      const statuses = [answered(x), answered(y)].sort();
      expect(statuses, `${show(x)}\n${show(y)}`).toEqual([200, 404]);
      const loser = x.statusCode === 404 ? x : y;
      expect(refusal(loser, 404).code).toBe('not_found');
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
      const key = await targetIdOf('MITIGATED_BY', risk.id, control.id);
      const entries = (await outboxEntries(env, orgId, 'link.removed')).filter((e) => e.targetId === key);
      expect(entries).toHaveLength(1);
    },
    T,
  );
});
