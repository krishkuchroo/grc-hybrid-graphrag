// S1-011 criterion 3 (D30, D47): the body of POST /api/v1/links/remove is a strict Zod schema,
// `{ type, fromId, toId }` with `type` one of the six link types and the IDs lowercase UUIDs. An
// unknown link type, a bad ID, a missing field or an extra field is 400 `validation_failed` in the
// D47 format, and the real link each body is built around stays.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  linkCount,
  makeRecord,
  newLinksOrg,
  outboxEntries,
  person,
  refusal,
  removeLink,
  seedLink,
  setUpRemoval,
  tearDownRemoval,
  type Person,
  type Rec,
  type RemovalEnv,
} from './helpers.js';

let env: RemovalEnv;
let orgId: string;
let admin: Person;
let risk: Rec;
let control: Rec;

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal Validation');
  orgId = org.id;
  admin = await person(env, org, 'admin', 'restricted');
  risk = await makeRecord(env, admin, 'risk', { label: 'internal' });
  control = await makeRecord(env, admin, 'control', { label: 'internal' });
  await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { createdBy: admin.id });
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

function good(): Record<string, unknown> {
  return { type: 'MITIGATED_BY', fromId: risk.id, toId: control.id };
}

const BAD: [string, () => unknown][] = [
  ['an unknown link type', () => ({ ...good(), type: 'OWNS' })],
  ['a later slice type (SATISFIES)', () => ({ ...good(), type: 'SATISFIES' })],
  ['a type in lower case', () => ({ ...good(), type: 'mitigated_by' })],
  ['an empty type', () => ({ ...good(), type: '' })],
  ['a type that is not a string', () => ({ ...good(), type: 7 })],
  ['fromId not a UUID', () => ({ ...good(), fromId: 'not-a-uuid' })],
  ['toId not a UUID', () => ({ ...good(), toId: 'RSK0001001' })],
  ['fromId in upper case', () => ({ ...good(), fromId: risk.id.toUpperCase() })],
  ['an empty toId', () => ({ ...good(), toId: '' })],
  ['toId a number', () => ({ ...good(), toId: 12 })],
  ['type missing', () => ({ fromId: risk.id, toId: control.id })],
  ['fromId missing', () => ({ type: 'MITIGATED_BY', toId: control.id })],
  ['toId missing', () => ({ type: 'MITIGATED_BY', fromId: risk.id })],
  ['an empty body', () => ({})],
  ['an extra field (origin)', () => ({ ...good(), origin: 'manual' })],
  ['an extra field (orgId)', () => ({ ...good(), orgId })],
  ['an array', () => [good()]],
];

describe('criterion 3: a bad body is 400 validation_failed', () => {
  it.each(BAD)(
    '%s',
    async (_what, make) => {
      const before = (await outboxEntries(env, orgId)).length;
      const r = refusal(await removeLink(env, admin, make()), 400);
      expect(r.code).toBe('validation_failed');
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
      expect((await outboxEntries(env, orgId)).length).toBe(before);
    },
    T,
  );
});
