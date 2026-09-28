// S1-003 criterion 3 (reads), D45.3, D51, D55, D59, D73: who sees what.
// - Every clearance × label pair on `get` and `list`, for every kind: 404 and left out of the list
//   (and out of `total`) when the label is above the clearance, as `isVisible` says.
// - The same for a Control Owner's own controls (their reads run as the writer, with
//   `owner = <their ID>` and `sensitivity IN <labels up to their clearance>` in the query).
// - Every ordered org pair: another org's record is 404 on get, update and retire, never listed,
//   and unchanged.
// - `get` and `list` run through `readAs` with the caller's role and clearance and
//   RECORD_READ_TIMEOUT_MS (5000), so Neo4j checks again; only a Control Owner's control reads
//   use the writer's `read`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABELS, RECORD_KINDS, isVisible } from '@grc/shared';
import {
  LONG,
  T,
  caller,
  fieldChange,
  loadRecords,
  newTestOrg,
  outcome,
  refusedWith,
  service,
  setUpRecords,
  spyGraph,
  storedNode,
  tearDownRecords,
  uniqueName,
  validInput,
  type Label,
  type RecEnv,
  type RecordKind,
  type RecordOut,
  type TestOrg,
} from './helpers.js';

let env: RecEnv;
let org: TestOrg;
let orgs: TestOrg[]; // three orgs for the org pairs

beforeAll(async () => {
  env = await setUpRecords();
  org = await newTestOrg(env, 'Visibility');
  orgs = [await newTestOrg(env, 'Wall One'), await newTestOrg(env, 'Wall Two'), await newTestOrg(env, 'Wall Three')];
}, LONG);

afterAll(async () => {
  await tearDownRecords(env);
}, LONG);

// ---------- fixtures, made once and shared (inside the tests, so a failure shows in each) ----------

interface Labelled {
  tag: string;
  byLabel: Record<Label, RecordOut>;
}

const labelled = new Map<RecordKind, Promise<Labelled>>();

/** One record of `kind` per label, all named with one tag, made by the Admin. */
function labelledRecords(kind: RecordKind): Promise<Labelled> {
  let p = labelled.get(kind);
  if (!p) {
    p = (async () => {
      const svc = await service(env);
      const tag = uniqueName(`vis-${kind}`).replace(/\s+/g, '-');
      const byLabel = {} as Record<Label, RecordOut>;
      for (const label of LABELS) {
        byLabel[label] = await svc.create(
          caller(org, 'admin'),
          kind,
          validInput(kind, { name: `${tag} ${label}`, label }),
        );
      }
      return { tag, byLabel };
    })();
    labelled.set(kind, p);
  }
  return p;
}

let owned: Promise<Labelled> | undefined;
/** One control per label, owned by the org's Control Owner. */
function ownedControls(): Promise<Labelled> {
  owned ??= (async () => {
    const svc = await service(env);
    const tag = uniqueName('vis-own').replace(/\s+/g, '-');
    const owner = org.users.byRole.control_owner;
    const byLabel = {} as Record<Label, RecordOut>;
    for (const label of LABELS) {
      byLabel[label] = await svc.create(
        caller(org, 'admin'),
        'control',
        validInput('control', { name: `${tag} ${label}`, label, owner }),
      );
    }
    return { tag, byLabel };
  })();
  return owned;
}

const PAIRS = LABELS.flatMap((clearance) => LABELS.map((label) => [clearance, label] as const));
const KIND_PAIRS = RECORD_KINDS.flatMap((kind) => PAIRS.map(([clearance, label]) => [kind, clearance, label] as const));

describe('every clearance × label pair on get, for every kind (D51, D59)', { timeout: T }, () => {
  // The Auditor may view all five kinds, so only the label decides.
  it.each(KIND_PAIRS)('%s: clearance %s, label %s', async (kind, clearance, label) => {
    const { byLabel } = await labelledRecords(kind);
    const svc = await service(env);
    const got = await outcome(svc.get(caller(org, 'auditor', clearance), kind, byLabel[label].id));
    expect(got).toBe(isVisible(clearance, label) ? 'ok' : 404);
  });
});

describe('every clearance × label pair on list, for every kind (D51, D59)', { timeout: T }, () => {
  const KIND_CLEARANCES = RECORD_KINDS.flatMap((kind) => LABELS.map((clearance) => [kind, clearance] as const));

  it.each(KIND_CLEARANCES)('%s: clearance %s lists exactly the labels at or below it', async (kind, clearance) => {
    const { tag, byLabel } = await labelledRecords(kind);
    const svc = await service(env);
    const page = await svc.list(caller(org, 'auditor', clearance), kind, { q: tag, pageSize: 100 });
    const want = LABELS.filter((l) => isVisible(clearance, l)).map((l) => byLabel[l].id);
    expect(page.items.map((r) => r.id).sort()).toEqual([...want].sort());
    expect(page.total, 'total counts only visible records').toBe(want.length);
  });
});

describe("a Control Owner's own controls: every clearance × label pair", { timeout: T }, () => {
  it.each(PAIRS)('clearance %s, label %s on get', async (clearance, label) => {
    const { byLabel } = await ownedControls();
    const svc = await service(env);
    const got = await outcome(svc.get(caller(org, 'control_owner', clearance), 'control', byLabel[label].id));
    expect(got).toBe(isVisible(clearance, label) ? 'ok' : 404);
  });

  it.each(LABELS)('clearance %s lists exactly the owned controls at or below it', async (clearance) => {
    const { tag, byLabel } = await ownedControls();
    const svc = await service(env);
    const page = await svc.list(caller(org, 'control_owner', clearance), 'control', { q: tag, pageSize: 100 });
    const want = LABELS.filter((l) => isVisible(clearance, l)).map((l) => byLabel[l].id);
    expect(page.items.map((r) => r.id).sort()).toEqual([...want].sort());
    expect(page.total).toBe(want.length);
  });

  it.each(PAIRS)('clearance %s, label %s on update: allowed only when visible', async (clearance, label) => {
    const svc = await service(env);
    const owner = org.users.byRole.control_owner;
    const rec = await svc.create(caller(org, 'admin'), 'control', validInput('control', { label, owner }));
    const got = await outcome(
      svc.update(caller(org, 'control_owner', clearance), 'control', rec.id, { name: uniqueName('co'), version: 1 }),
    );
    expect(got).toBe(isVisible(clearance, label) ? 'ok' : 404);
  });
});

describe('labels above the clearance on update and retire', { timeout: T }, () => {
  it.each(RECORD_KINDS)(
    'an Admin with clearance internal gets 404 on a restricted %s, and it is unchanged',
    async (kind) => {
      const svc = await service(env);
      const rec = await svc.create(caller(org, 'admin'), kind, validInput(kind, { label: 'restricted' }));
      const who = caller(org, 'admin', 'internal');
      await refusedWith(svc.update(who, kind, rec.id, { ...fieldChange(kind), version: 1 }), 404, 'not_found');
      await refusedWith(svc.retire(who, kind, rec.id, 1), 404, 'not_found');
      const node = await storedNode(env, org.id, kind, rec.id);
      expect(node?.['version']).toBe(1);
      expect(node?.['status']).toBe('active');
    },
  );
});

describe('every ordered org pair (D55, D59)', { timeout: T }, () => {
  const ORDERED = [0, 1, 2].flatMap((x) => [0, 1, 2].filter((y) => y !== x).map((y) => [x, y] as const));
  const CASES = ORDERED.flatMap(([x, y]) => RECORD_KINDS.map((kind) => [x, y, kind] as const));

  it.each(CASES)(
    'org %i reaching org %i: a %s is 404 on get, update and retire, and never listed',
    async (x, y, kind) => {
      const svc = await service(env);
      const mine = orgs[x]!;
      const theirs = orgs[y]!;
      const rec = await svc.create(caller(theirs, 'admin'), kind, validInput(kind, { label: 'public' }));
      const who = caller(mine, 'admin');
      await refusedWith(svc.get(who, kind, rec.id), 404, 'not_found');
      await refusedWith(svc.update(who, kind, rec.id, { ...fieldChange(kind), version: 1 }), 404, 'not_found');
      await refusedWith(svc.retire(who, kind, rec.id, 1), 404, 'not_found');
      for (const status of ['active', 'all']) {
        const page = await svc.list(who, kind, { q: rec.name, status, pageSize: 100 });
        expect(page.items.map((r) => r.id)).not.toContain(rec.id);
      }
      const node = await storedNode(env, theirs.id, kind, rec.id);
      expect(node?.['version']).toBe(1);
      expect(node?.['status']).toBe('active');
    },
  );
});

describe('reads go through the read-only accounts (D45.3, D73)', { timeout: T }, () => {
  it('RECORD_READ_TIMEOUT_MS is 5000', async () => {
    expect((await loadRecords()).RECORD_READ_TIMEOUT_MS).toBe(5000);
  });

  it.each(['get', 'list'] as const)(
    'a Viewer %s of risks uses readAs with the role and clearance, never the writer',
    async (op) => {
      const { byLabel } = await labelledRecords('risk');
      const spy = spyGraph(env.graph);
      const svc = await service(env, { graph: spy.graph });
      const who = caller(org, 'viewer', 'confidential');
      if (op === 'get') await svc.get(who, 'risk', byLabel.public.id);
      else await svc.list(who, 'risk', {});
      expect(spy.calls.readAs.length).toBeGreaterThan(0);
      for (const call of spy.calls.readAs) {
        expect(call).toEqual({ role: 'viewer', clearance: 'confidential', timeoutMs: 5000 });
      }
      expect(spy.calls.read, 'writer reads').toBe(0);
      expect(spy.calls.write, 'writes').toBe(0);
    },
  );

  it('a Control Owner reading risks also uses readAs', async () => {
    const { byLabel } = await labelledRecords('risk');
    const spy = spyGraph(env.graph);
    const svc = await service(env, { graph: spy.graph });
    await svc.get(caller(org, 'control_owner', 'internal'), 'risk', byLabel.public.id);
    expect(spy.calls.readAs.length).toBeGreaterThan(0);
    for (const call of spy.calls.readAs) {
      expect(call).toEqual({ role: 'control_owner', clearance: 'internal', timeoutMs: 5000 });
    }
    expect(spy.calls.read).toBe(0);
  });

  it("a Control Owner's control reads run as the writer, and never write", async () => {
    const { byLabel } = await ownedControls();
    const spy = spyGraph(env.graph);
    const svc = await service(env, { graph: spy.graph });
    const who = caller(org, 'control_owner', 'restricted');
    await svc.get(who, 'control', byLabel.public.id);
    await svc.list(who, 'control', {});
    expect(spy.calls.read).toBeGreaterThan(0);
    expect(spy.calls.write).toBe(0);
  });
});
