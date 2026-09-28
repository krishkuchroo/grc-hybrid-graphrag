// S1-004 criterion 4 (D59, every clearance x label pair; D51) and the label rule of criterion 2
// (D198: no label above one's own clearance).
// - For 4 clearances x 4 labels, GET :id is 200 or 404, and the list includes or leaves out the
//   record, exactly as `isVisible(clearance, label)` says; `total` counts only visible records.
//   Checked for every kind with an Admin (who may view every type), and for a Control Owner's own
//   controls, whose reads run as the writer (the S1 shared notes' "own" exception).
// - For 4 clearances x 4 labels, a create with that label, and a label change to it, is allowed at
//   or below the caller's clearance and 403 above it, with nothing saved or changed (D198).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isVisible } from '@grc/shared';
import {
  LABELS,
  LONG,
  RECORD_KINDS,
  T,
  countNamed,
  createR,
  expectRefused,
  expectUnchanged,
  getR,
  json,
  listR,
  newApiOrg,
  patchR,
  person,
  seed,
  setUpRecordsApi,
  show,
  tearDownRecordsApi,
  uniqueName,
  validInput,
  type ApiEnv,
  type Label,
  type Org,
  type RecordKind,
  type RecordOut,
  type Role,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let seeder: SignedIn;
const admins = new Map<Label, SignedIn>();
const owners = new Map<Label, SignedIn>();
const editors = new Map<Role, SignedIn>();
// A tag in every record name, so a `q` list returns only this file's records of one set.
const TAG = `clr${Date.now().toString(36)}`;
// byKind[kind][label]: one record per kind and label, owned by the seeder.
const byKind = {} as Record<RecordKind, Record<Label, RecordOut>>;
// ownControls[clearance][label]: one control per label, owned by the Control Owner of that clearance.
const ownControls = new Map<Label, Record<Label, RecordOut>>();

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api Clearance');
  seeder = await person(env, org, 'admin', 'restricted');
  for (const c of LABELS) {
    admins.set(c, await person(env, org, 'admin', c));
    owners.set(c, await person(env, org, 'control_owner', c));
  }
  for (const role of ['risk_manager', 'compliance_manager', 'analyst'] as const) {
    editors.set(role, await person(env, org, role, 'internal'));
  }
  for (const kind of RECORD_KINDS) {
    byKind[kind] = {} as Record<Label, RecordOut>;
    for (const l of LABELS) {
      byKind[kind][l] = await seed(env, seeder, kind, { label: l, name: uniqueName(`${TAG} all ${kind} ${l}`) });
    }
  }
  for (const c of LABELS) {
    const mine = {} as Record<Label, RecordOut>;
    for (const l of LABELS) {
      mine[l] = await seed(env, seeder, 'control', {
        label: l,
        owner: owners.get(c)!.user.id,
        name: uniqueName(`${TAG} own ${c} ${l}`),
      });
    }
    ownControls.set(c, mine);
  }
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

const PAIRS = LABELS.flatMap((clearance) =>
  LABELS.map((label) => ({ clearance, label, visible: isVisible(clearance, label) })),
);
const KIND_PAIRS = RECORD_KINDS.flatMap((kind) => PAIRS.map((p) => ({ kind, ...p })));

describe('criterion 4: every clearance x label pair on GET :id and the list (D51, D59)', { timeout: T }, () => {
  it('covers 4 x 4 pairs for each of the 5 kinds', () => {
    expect(PAIRS).toHaveLength(16);
    expect(KIND_PAIRS).toHaveLength(80);
  });

  it.each(KIND_PAIRS)(
    'Admin at $clearance, $kind labelled $label: GET :id visible=$visible',
    async ({ kind, clearance, label, visible }) => {
      const rec = byKind[kind][label];
      const res = await getR(e(), admins.get(clearance)!, kind, rec.id);
      if (visible) {
        expect(res.statusCode, show(res)).toBe(200);
        expect(json(res)).toMatchObject({ id: rec.id, label });
      } else {
        expectRefused(res, 404, 'not_found');
      }
    },
  );

  it.each(RECORD_KINDS.flatMap((kind) => LABELS.map((clearance) => ({ kind, clearance }))))(
    'Admin at $clearance: the $kind list holds exactly the visible labels, and total counts only them',
    async ({ kind, clearance }) => {
      const res = await listR(e(), admins.get(clearance)!, kind, `?status=all&pageSize=100&q=${TAG}%20all`);
      expect(res.statusCode, show(res)).toBe(200);
      const body = json(res) as { items: { id: string; label: string }[]; total: number };
      const expected = LABELS.filter((l) => isVisible(clearance, l)).map((l) => byKind[kind][l].id);
      expect(body.items.map((i) => i.id).sort()).toEqual([...expected].sort());
      expect(body.total).toBe(expected.length);
    },
  );

  it.each(PAIRS)(
    'Control Owner at $clearance, own control labelled $label: GET :id visible=$visible',
    async ({ clearance, label, visible }) => {
      const rec = ownControls.get(clearance)![label];
      const res = await getR(e(), owners.get(clearance)!, 'control', rec.id);
      if (visible) expect(res.statusCode, show(res)).toBe(200);
      else expectRefused(res, 404, 'not_found');
    },
  );

  it.each(LABELS)(
    'Control Owner at %s: the control list holds exactly their visible own controls',
    async (clearance) => {
      const res = await listR(e(), owners.get(clearance)!, 'control', `?status=all&pageSize=100&q=${TAG}`);
      expect(res.statusCode, show(res)).toBe(200);
      const body = json(res) as { items: { id: string }[]; total: number };
      const mine = ownControls.get(clearance)!;
      const expected = LABELS.filter((l) => isVisible(clearance, l)).map((l) => mine[l].id);
      expect(body.items.map((i) => i.id).sort()).toEqual([...expected].sort());
      expect(body.total).toBe(expected.length);
    },
  );
});

describe('D198: no label above the caller clearance, on create and on a label change', { timeout: T }, () => {
  it.each(PAIRS)(
    'Admin at $clearance creates a risk labelled $label: allowed=$visible',
    async ({ clearance, label, visible }) => {
      const body = validInput('risk', { label });
      const res = await createR(e(), admins.get(clearance)!, 'risk', body);
      if (visible) {
        expect(res.statusCode, show(res)).toBe(201);
        expect(json(res)).toMatchObject({ label });
      } else {
        expectRefused(res, 403, 'forbidden');
        expect(await countNamed(e(), org.id, 'risk', body.name as string), 'nothing was created').toBe(0);
      }
    },
  );

  it.each(PAIRS)(
    'Admin at $clearance changes a public risk to $label: allowed=$visible',
    async ({ clearance, label, visible }) => {
      const rec = await seed(e(), seeder, 'risk', { label: 'public' });
      const res = await patchR(e(), admins.get(clearance)!, 'risk', rec.id, { label, version: rec.version });
      if (visible) {
        expect(res.statusCode, show(res)).toBe(200);
        expect(json(res)).toMatchObject({ label });
      } else {
        expectRefused(res, 403, 'forbidden');
        await expectUnchanged(e(), org.id, 'risk', rec);
      }
    },
  );

  const EDITOR_CASES: { role: Role; kind: RecordKind }[] = [
    { role: 'risk_manager', kind: 'risk' },
    { role: 'compliance_manager', kind: 'control' },
    { role: 'compliance_manager', kind: 'policy' },
    { role: 'analyst', kind: 'incident' },
  ];

  it.each(EDITOR_CASES)(
    '$role at internal: a $kind labelled confidential is 403, internal is 201',
    async ({ role, kind }) => {
      const me = editors.get(role)!;
      const above = validInput(kind, { label: 'confidential' });
      expectRefused(await createR(e(), me, kind, above), 403, 'forbidden');
      expect(await countNamed(e(), org.id, kind, above.name as string)).toBe(0);
      const at = await createR(e(), me, kind, validInput(kind, { label: 'internal' }));
      expect(at.statusCode, show(at)).toBe(201);
    },
  );
});
