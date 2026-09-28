// S1-011 criterion 8, every clearance x label pair (D59, D51): 4 clearances x 4 labels, for an Admin
// (may edit every type) and a Risk Manager (edits the risk end only). A link from a public risk to a
// control labelled L: a caller whose clearance is at or above L removes it (200); below L, it's 404
// `not_found` and the link stays, whichever end carries the label. The expectation is worked out
// from LABELS' order, not through isVisible.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LABELS,
  LONG,
  T,
  body,
  labelRank,
  linkCount,
  makeRecord,
  newLinksOrg,
  person,
  refusal,
  removeLink,
  removed,
  seedLink,
  setUpRemoval,
  tearDownRemoval,
  type Label,
  type Person,
  type RemovalEnv,
  type Role,
} from './helpers.js';

const ROLES_HERE: Role[] = ['admin', 'risk_manager'];

let env: RemovalEnv;
let orgId: string;
let creator: Person;
const people = new Map<string, Person>();

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal Clearance');
  orgId = org.id;
  creator = await person(env, org, 'admin', 'restricted');
  for (const role of ROLES_HERE) {
    for (const clearance of LABELS) people.set(`${role}/${clearance}`, await person(env, org, role, clearance));
  }
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

function sees(clearance: Label, label: Label): boolean {
  return labelRank(clearance) >= labelRank(label);
}

const COMBOS = ROLES_HERE.flatMap((role) =>
  LABELS.flatMap((clearance) => LABELS.map((label) => [role, clearance, label] as const)),
);

describe('criterion 8: every clearance x label', () => {
  it(`covers 2 roles x 4 clearances x 4 labels (${COMBOS.length})`, () => {
    expect(COMBOS).toHaveLength(32);
  });

  it.each(COMBOS)(
    '%s with clearance %s, the control end labelled %s',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const risk = await makeRecord(env, creator, 'risk', { label: 'public' });
      const control = await makeRecord(env, creator, 'control', { label });
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { createdBy: creator.id });
      const res = await removeLink(env, who, body('MITIGATED_BY', risk, control));
      if (sees(clearance, label)) {
        removed(res, body('MITIGATED_BY', risk, control));
        expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
      } else {
        expect(refusal(res, 404).code).toBe('not_found');
        expect(res.body).not.toContain(control.number);
        expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
      }
    },
    T,
  );

  it.each(COMBOS)(
    '%s with clearance %s, the risk end labelled %s',
    async (role, clearance, label) => {
      const who = people.get(`${role}/${clearance}`)!;
      const risk = await makeRecord(env, creator, 'risk', { label });
      const control = await makeRecord(env, creator, 'control', { label: 'public' });
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control, { createdBy: creator.id });
      const res = await removeLink(env, who, body('MITIGATED_BY', risk, control));
      if (sees(clearance, label)) {
        removed(res, body('MITIGATED_BY', risk, control));
        expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(0);
      } else {
        expect(refusal(res, 404).code).toBe('not_found');
        expect(res.body).not.toContain(risk.number);
        expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
      }
    },
    T,
  );
});
