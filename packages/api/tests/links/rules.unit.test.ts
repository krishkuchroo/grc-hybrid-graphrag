// S1-005, the rule functions (D200, D204, D50, D51, the spec's ontology). No databases.
//
// - `canLinkRecords(caller, from, to)` in packages/shared/src/records/link-rules.ts, exported from
//   `@grc/shared`. `caller` is `{ userId, role, clearance }`, `from` and `to` are
//   `{ kind, label, owner }`. D200: true when the caller can edit either record (the D50 `edit`
//   cell, or `edit_own` on a control they own) and can see both (the role may view the type, a
//   Control Owner owns any control end, and the label is at or below their clearance).
// - The expected answers are worked out here from the ROLE_TABLE cells and LABELS directly, not
//   through `can` or `isVisible`, so a mistake in the function can't agree with itself.
// - The ontology check is `isAllowedLink(type, fromKind, toKind)` (S1-001); the service asks both.
// - D204's numbers: MAP_DEFAULT_DEPTH = 2, MAP_MAX_DEPTH = 3, MAP_MAX_NODES = 200, from
//   packages/shared/src/records/links.ts through `@grc/shared`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as shared from '@grc/shared';
import { LABELS, ROLE_TABLE, ROLES, isAllowedLink, type Label, type RecordKind, type Role } from '@grc/shared';

const KINDS: readonly RecordKind[] = ['asset', 'risk', 'control', 'policy', 'incident'];
const ME = 'user-me';
const SOMEONE_ELSE = 'user-someone-else';

const LINK_RULES_FILE = fileURLToPath(new URL('../../../shared/src/records/link-rules.ts', import.meta.url));

interface End {
  kind: string;
  label: string;
  owner: string;
}
interface LinkCaller {
  userId: string;
  role: string;
  clearance: string;
}
type CanLink = (caller: LinkCaller, from: End, to: End) => boolean;

function canLinkRecords(): CanLink {
  const fn = (shared as Record<string, unknown>)['canLinkRecords'];
  expect(typeof fn, '`canLinkRecords` is exported from @grc/shared (packages/shared/src/records/index.ts)').toBe(
    'function',
  );
  return fn as CanLink;
}

// ---- the expectation, straight from the table ----

function cell(role: Role, kind: RecordKind): string {
  return (ROLE_TABLE as unknown as Record<string, Record<string, string>>)[kind]![role]!;
}

function viewable(role: Role, kind: RecordKind, owned: boolean): boolean {
  const c = cell(role, kind);
  return c === 'view' || c === 'edit' || (c === 'edit_own' && owned);
}

function editable(role: Role, kind: RecordKind, owned: boolean): boolean {
  const c = cell(role, kind);
  return c === 'edit' || (c === 'edit_own' && owned);
}

function cleared(clearance: Label, label: Label): boolean {
  return LABELS.indexOf(clearance) >= LABELS.indexOf(label);
}

interface Case {
  from: { kind: RecordKind; label: Label; owned: boolean };
  to: { kind: RecordKind; label: Label; owned: boolean };
}

function expected(role: Role, clearance: Label, c: Case): boolean {
  const seeFrom = viewable(role, c.from.kind, c.from.owned) && cleared(clearance, c.from.label);
  const seeTo = viewable(role, c.to.kind, c.to.owned) && cleared(clearance, c.to.label);
  const editOne = editable(role, c.from.kind, c.from.owned) || editable(role, c.to.kind, c.to.owned);
  return seeFrom && seeTo && editOne;
}

function end(e: Case['from']): End {
  return { kind: e.kind, label: e.label, owner: e.owned ? ME : SOMEONE_ELSE };
}

describe('link-rules.ts is where the brief puts it', () => {
  it('packages/shared/src/records/link-rules.ts exists', () => {
    expect(existsSync(LINK_RULES_FILE), 'packages/shared/src/records/link-rules.ts does not exist yet').toBe(true);
  });
});

describe('D200: canLinkRecords, every role x ordered pair of kinds (ROLE_TABLE)', () => {
  const pairs = ROLES.flatMap((role) => KINDS.flatMap((from) => KINDS.map((to) => [role, from, to] as const)));

  it('covers 7 roles x 5 x 5 kinds', () => {
    expect(pairs).toHaveLength(7 * 5 * 5);
  });

  it.each(pairs)('%s: %s -> %s, each ownership of the two ends', (role, from, to) => {
    const fn = canLinkRecords();
    for (const fromOwned of [true, false]) {
      for (const toOwned of [true, false]) {
        const c: Case = {
          from: { kind: from, label: 'internal', owned: fromOwned },
          to: { kind: to, label: 'internal', owned: toOwned },
        };
        const want = expected(role, 'restricted', c);
        const got = fn({ userId: ME, role, clearance: 'restricted' }, end(c.from), end(c.to));
        expect(got, `${role} ${from}(${fromOwned ? 'own' : 'not own'}) -> ${to}(${toOwned ? 'own' : 'not own'})`).toBe(
          want,
        );
      }
    }
  });
});

describe('D200: canLinkRecords, the brief examples', () => {
  it('a Risk Manager may link their risk to a control they can only view', () => {
    const fn = canLinkRecords();
    const rm = { userId: ME, role: 'risk_manager', clearance: 'internal' };
    expect(
      fn(
        rm,
        { kind: 'risk', label: 'internal', owner: ME },
        { kind: 'control', label: 'internal', owner: SOMEONE_ELSE },
      ),
    ).toBe(true);
  });

  it('a Risk Manager may not link a control to a policy (they can edit neither)', () => {
    const fn = canLinkRecords();
    const rm = { userId: ME, role: 'risk_manager', clearance: 'restricted' };
    expect(
      fn(rm, { kind: 'control', label: 'public', owner: ME }, { kind: 'policy', label: 'public', owner: ME }),
    ).toBe(false);
  });

  it.each(KINDS.flatMap((from) => KINDS.map((to) => [from, to] as const)))(
    'a Viewer may link nothing (%s -> %s)',
    (from, to) => {
      const fn = canLinkRecords();
      const viewer = { userId: ME, role: 'viewer', clearance: 'restricted' };
      expect(fn(viewer, { kind: from, label: 'public', owner: ME }, { kind: to, label: 'public', owner: ME })).toBe(
        false,
      );
    },
  );

  it('a Control Owner may link their own control to a policy they can view', () => {
    const fn = canLinkRecords();
    const co = { userId: ME, role: 'control_owner', clearance: 'internal' };
    expect(
      fn(
        co,
        { kind: 'control', label: 'internal', owner: ME },
        { kind: 'policy', label: 'internal', owner: SOMEONE_ELSE },
      ),
    ).toBe(true);
    expect(
      fn(
        co,
        { kind: 'risk', label: 'internal', owner: SOMEONE_ELSE },
        { kind: 'control', label: 'internal', owner: ME },
      ),
    ).toBe(true);
  });

  it("a Control Owner may not link someone else's control (they can't see it)", () => {
    const fn = canLinkRecords();
    const co = { userId: ME, role: 'control_owner', clearance: 'restricted' };
    expect(
      fn(
        co,
        { kind: 'control', label: 'internal', owner: SOMEONE_ELSE },
        { kind: 'policy', label: 'internal', owner: ME },
      ),
    ).toBe(false);
    expect(
      fn(
        co,
        { kind: 'risk', label: 'internal', owner: ME },
        { kind: 'control', label: 'internal', owner: SOMEONE_ELSE },
      ),
    ).toBe(false);
  });

  it('an Analyst may link an incident to an asset and a risk; an Auditor may not', () => {
    const fn = canLinkRecords();
    const analyst = { userId: ME, role: 'analyst', clearance: 'restricted' };
    const auditor = { userId: ME, role: 'auditor', clearance: 'restricted' };
    const incident = { kind: 'incident', label: 'confidential', owner: SOMEONE_ELSE };
    expect(fn(analyst, incident, { kind: 'asset', label: 'internal', owner: SOMEONE_ELSE })).toBe(true);
    expect(fn(analyst, incident, { kind: 'risk', label: 'internal', owner: SOMEONE_ELSE })).toBe(true);
    expect(fn(auditor, incident, { kind: 'asset', label: 'internal', owner: SOMEONE_ELSE })).toBe(false);
  });
});

describe('D200 + D51: canLinkRecords, every clearance x label on each end', () => {
  const combos = LABELS.flatMap((clearance) => LABELS.map((label) => [clearance, label] as const));

  it.each(combos)('an Admin with clearance %s, one end labelled %s', (clearance, label) => {
    const fn = canLinkRecords();
    const admin = { userId: ME, role: 'admin', clearance };
    const low = { kind: 'risk', label: 'public', owner: SOMEONE_ELSE };
    const other = { kind: 'control', label, owner: SOMEONE_ELSE };
    const want = cleared(clearance, label);
    expect(fn(admin, low, other), 'the labelled end is the "to" end').toBe(want);
    const lowPolicy = { kind: 'policy', label: 'public', owner: SOMEONE_ELSE };
    expect(fn(admin, other, lowPolicy), 'the labelled end is the "from" end').toBe(want);
  });

  it.each(combos)('a Risk Manager with clearance %s, the risk they edit labelled %s', (clearance, label) => {
    const fn = canLinkRecords();
    const rm = { userId: ME, role: 'risk_manager', clearance };
    const risk = { kind: 'risk', label, owner: SOMEONE_ELSE };
    const control = { kind: 'control', label: 'public', owner: SOMEONE_ELSE };
    expect(fn(rm, risk, control)).toBe(cleared(clearance, label));
  });

  it.each(combos)('a Control Owner with clearance %s, their own control labelled %s', (clearance, label) => {
    const fn = canLinkRecords();
    const co = { userId: ME, role: 'control_owner', clearance };
    const control = { kind: 'control', label, owner: ME };
    const policy = { kind: 'policy', label: 'public', owner: SOMEONE_ELSE };
    expect(fn(co, control, policy)).toBe(cleared(clearance, label));
  });
});

describe('canLinkRecords refuses anything unknown (fail safe, D45.7)', () => {
  const risk = { kind: 'risk', label: 'internal', owner: ME };
  const control = { kind: 'control', label: 'internal', owner: ME };

  it.each([
    ['an unknown role', { userId: ME, role: 'superuser', clearance: 'restricted' }, risk, control],
    ['an unknown clearance', { userId: ME, role: 'admin', clearance: 'top-secret' }, risk, control],
    ['an unknown label', { userId: ME, role: 'admin', clearance: 'restricted' }, { ...risk, label: 'secret' }, control],
    ['an unknown kind', { userId: ME, role: 'admin', clearance: 'restricted' }, { ...risk, kind: 'threat' }, control],
    [
      'a later-slice kind',
      { userId: ME, role: 'admin', clearance: 'restricted' },
      { ...risk, kind: 'requirement' },
      control,
    ],
  ] as const)('%s', (_what, who, from, to) => {
    const fn = canLinkRecords();
    expect(fn(who, from, to)).toBe(false);
  });
});

describe('the ontology check the service asks (isAllowedLink, S1-001)', () => {
  const ALLOWED = [
    ['HOSTS', 'asset', 'asset'],
    ['RUNS', 'asset', 'asset'],
    ['EXPOSED_TO', 'asset', 'risk'],
    ['MITIGATED_BY', 'risk', 'control'],
    ['GOVERNED_BY', 'control', 'policy'],
    ['IMPACTS', 'incident', 'asset'],
    ['EXPOSES', 'incident', 'risk'],
  ] as const;

  it.each(ALLOWED)('%s from %s to %s is allowed', (type, from, to) => {
    expect(isAllowedLink(type, from, to)).toBe(true);
  });

  it.each(ALLOWED.filter(([, from, to]) => from !== to))(
    '%s from %s to %s is refused the other way round',
    (type, from, to) => {
      expect(isAllowedLink(type, to, from)).toBe(false);
    },
  );
});

describe('D204: the map numbers live in @grc/shared', () => {
  it.each([
    ['MAP_DEFAULT_DEPTH', 2],
    ['MAP_MAX_DEPTH', 3],
    ['MAP_MAX_NODES', 200],
  ] as const)('%s is %d', (name, value) => {
    expect((shared as Record<string, unknown>)[name], `${name} is exported from @grc/shared`).toBe(value);
  });
});
