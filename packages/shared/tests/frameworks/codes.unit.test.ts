// S2-001 criteria 2, 3 and 4 (D20, D212 (1), D67, D68): requirement codes, their groups, parent
// codes and natural order, and the stable IDs of catalog nodes.
//
// Readings the tests rely on:
// - "Natural order" is plain string order of `sortKeyOf` (JavaScript's default `<`), so every
//   consumer (Cypher ORDER BY, Array.prototype.sort) agrees without a locale.
// - NIST 800-53 families sort by their two-letter code, the order NIST publishes them in.
// - The order across CSF functions and categories, and across SOC 2 series kinds (CC, A1, C1, PI1,
//   P), is not fixed by the plan, so it is not tested; within a category or series it is.
// - The IDs are the RFC 9562 UUID v5 of `framework:<key>` and `requirement:<key>:<code>` in the
//   exported CATALOG_NAMESPACE, made as `orgIdForSlug` makes org IDs (packages/api/src/identity/
//   provision-org.ts): SHA-1 of the namespace bytes then the UTF-8 name, version and variant bits set.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KEYS, SAMPLES, type Key } from './expected.js';
import { loadFrameworks } from './load.js';

const PATTERNS: Record<Key, string> = {
  nist_800_53: '^[A-Z]{2}-\\d{1,2}(\\(\\d{1,2}\\))?$',
  nist_csf_2: '^(GV|ID|PR|DE|RS|RC)\\.[A-Z]{2}-\\d{2}$',
  iso_27001: '^A\\.[5-8]\\.\\d{1,2}$',
  soc_2: '^(CC[1-9]|A1|C1|PI1|P[1-8])\\.\\d{1,2}$',
};

/** Codes no framework accepts: wrong case, malformed, spaces, empty. */
const REFUSED_EVERYWHERE = [
  'ac-2',
  'AC2',
  'A.9.1',
  'CC0.1',
  'GV.OC-1',
  '',
  ' ',
  'AC-2 ',
  ' AC-2',
  'AC -2',
  'AC-2 (1)',
  'GV.OC 01',
  'A.5. 1',
  'CC6. 1',
  'gv.oc-01',
  'a.5.1',
  'cc6.1',
  'AC-2(1',
  'AC-2()',
  'AC-100',
  'AC-2(100)',
  'GV.OC-001',
  'XX.OC-01',
  'A.4.1',
  'A.5.100',
  'CC10.1',
  'P9.1',
  'PI2.1',
  'AC-2\n',
];

/** A valid code of one framework is refused by every other one. */
const CROSS: [Key, string][] = [
  ['nist_800_53', 'AC-2'],
  ['nist_800_53', 'SI-4(24)'],
  ['nist_csf_2', 'GV.OC-01'],
  ['nist_csf_2', 'PR.AA-05'],
  ['iso_27001', 'A.5.1'],
  ['iso_27001', 'A.8.34'],
  ['soc_2', 'CC6.1'],
  ['soc_2', 'P8.1'],
];

/** Codes the brief's pattern for each framework accepts, beyond the samples: the edges of each range. */
const PATTERN_EDGES: Record<Key, string[]> = {
  nist_800_53: ['AC-1', 'SR-12', 'AC-99', 'AC-2(99)', 'SC-7(5)'],
  nist_csf_2: ['GV.OC-01', 'RC.CO-04', 'ID.AM-99'],
  iso_27001: ['A.5.1', 'A.8.34', 'A.6.99'],
  soc_2: ['CC1.1', 'CC9.99', 'A1.1', 'C1.2', 'PI1.5', 'P1.1', 'P8.1'],
};

describe('criterion 2: CODE_PATTERNS', () => {
  // The behaviour of the brief's patterns, not their exact text: any equivalent RegExp passes.
  it.each(KEYS)('%s accepts and refuses what the brief pattern does', async (key) => {
    const { CODE_PATTERNS } = await loadFrameworks();
    const pattern = CODE_PATTERNS[key]!;
    const brief = new RegExp(PATTERNS[key]);
    expect(pattern).toBeInstanceOf(RegExp);
    const codes = [...SAMPLES.map(([, code]) => code), ...KEYS.flatMap((k) => PATTERN_EDGES[k]), ...REFUSED_EVERYWHERE];
    for (const code of codes) {
      // Twice each: a pattern with the g or y flag would answer differently the second time.
      expect([pattern.test(code), pattern.test(code)], `${key} ${JSON.stringify(code)}`).toEqual([
        brief.test(code),
        brief.test(code),
      ]);
    }
  });

  it('has a pattern for exactly the four frameworks', async () => {
    const { CODE_PATTERNS } = await loadFrameworks();
    expect(Object.keys(CODE_PATTERNS).sort()).toEqual([...KEYS].sort());
  });
});

describe('criterion 2: isRequirementCode', () => {
  it.each(SAMPLES.map(([key, code]) => [key, code] as const))('%s accepts %s', async (key, code) => {
    const { isRequirementCode } = await loadFrameworks();
    expect(isRequirementCode(key, code)).toBe(true);
  });

  it.each(KEYS.flatMap((key) => REFUSED_EVERYWHERE.map((code) => [key, code] as const)))(
    '%s refuses %j',
    async (key, code) => {
      const { isRequirementCode } = await loadFrameworks();
      expect(isRequirementCode(key, code)).toBe(false);
    },
  );

  it.each(CROSS.flatMap(([owner, code]) => KEYS.filter((k) => k !== owner).map((key) => [key, code, owner] as const)))(
    '%s refuses %s (a %s code)',
    async (key, code) => {
      const { isRequirementCode } = await loadFrameworks();
      expect(isRequirementCode(key, code)).toBe(false);
    },
  );

  it.each([
    ['scf', 'AC-2'],
    ['NIST_800_53', 'AC-2'],
    ['', 'AC-2'],
    [undefined, 'AC-2'],
    [null, 'A.5.1'],
    ['toString', 'AC-2'],
  ])('refuses an unknown framework key %j', async (key, code) => {
    const { isRequirementCode } = await loadFrameworks();
    expect(isRequirementCode(key, code)).toBe(false);
  });

  it.each([null, undefined, 2, {}, ['AC-2']])('refuses a code that is not a string: %j', async (code) => {
    const { isRequirementCode } = await loadFrameworks();
    expect(isRequirementCode('nist_800_53', code)).toBe(false);
  });

  // Codes kept exactly as published (D212 (1)): a look-alike character must not pass as the real
  // one, or one requirement could appear twice under codes that look the same.
  it.each([
    ['nist_800_53', 'AC‐2'], // a Unicode hyphen
    ['nist_800_53', 'AC−2'], // a minus sign
    ['nist_800_53', 'AC-２'], // a full-width 2
    ['nist_800_53', 'АС-2'], // Cyrillic A and S
    ['nist_800_53', 'AC-2（1）'], // full-width brackets
    ['nist_800_53', 'AC-٢'], // an Arabic-Indic 2
    ['nist_csf_2', 'GV․OC-01'], // a one-dot leader
    ['iso_27001', 'A.5.١'], // an Arabic-Indic 1
    ['soc_2', 'CC6．1'], // a full-width full stop
    ['nist_800_53', 'AC-2​'], // a zero-width space
  ])('%s refuses the look-alike %j', async (key, code) => {
    const { isRequirementCode } = await loadFrameworks();
    expect(isRequirementCode(key, code)).toBe(false);
  });

  it('gives the same answer every call (no stateful regex)', async () => {
    const { isRequirementCode } = await loadFrameworks();
    for (const [key, code] of SAMPLES) {
      const answers = [1, 2, 3].map(() => isRequirementCode(key, code));
      expect(answers, `${key} ${code}`).toEqual([true, true, true]);
    }
  });
});

describe('criterion 3: groupOf', () => {
  it.each(SAMPLES)('%s: groupOf(%s) is %s', async (key, code, group) => {
    const { groupOf } = await loadFrameworks();
    expect(groupOf(key, code)).toBe(group);
  });

  it('every sample group is a group with a name in FRAMEWORKS', async () => {
    const { groupOf, FRAMEWORKS } = await loadFrameworks();
    for (const [key, code] of SAMPLES) {
      const group = groupOf(key, code);
      expect(FRAMEWORKS[key]!.groupNames[group], `${key} ${code} -> ${group}`).toEqual(expect.any(String));
    }
  });
});

describe('criterion 3: parentCodeOf', () => {
  it.each(SAMPLES)('%s: parentCodeOf(%s) -> group %s, parent %s', async (key, code, _group, parent) => {
    const { parentCodeOf } = await loadFrameworks();
    expect(parentCodeOf(key, code)).toBe(parent);
  });

  it.each([
    ['AC-2(10)', 'AC-2'],
    ['AC-17(3)', 'AC-17'],
    ['SC-7(21)', 'SC-7'],
  ])('800-53 enhancement %s has parent %s', async (code, parent) => {
    const { parentCodeOf } = await loadFrameworks();
    expect(parentCodeOf('nist_800_53', code)).toBe(parent);
  });
});

// Fail safe (D45.7): a code that isn't the framework's never gets a real answer. The risk is a
// malformed or foreign code that starts like a real one (`GV.OC-1` starts like `GV.OC`, `AC2` like
// `AC`, `A.5.100` like `A.5`) being filed under a real group or given a real parent. Throwing and
// returning a non-answer both pass; the outcome helper records which happened.
type Outcome = { threw: true } | { threw: false; value: unknown };

function outcome(run: () => unknown): Outcome {
  try {
    return { threw: false, value: run() };
  } catch {
    return { threw: true };
  }
}

const NOT_THE_FRAMEWORKS: [Key, string][] = [
  ['nist_800_53', 'AC2'],
  ['nist_800_53', 'ACX'],
  ['nist_800_53', 'AC-2 '],
  ['nist_800_53', 'AC-2(1'],
  ['nist_800_53', 'AC-100'],
  ['nist_800_53', 'GV.OC-01'],
  ['nist_csf_2', 'GV.OC-1'],
  ['nist_csf_2', 'GV.OC-001'],
  ['nist_csf_2', 'PR.AA-05 '],
  ['nist_csf_2', 'AC-2(1)'],
  ['iso_27001', 'A.5.100'],
  ['iso_27001', 'A.5.'],
  ['iso_27001', 'A.9.1'],
  ['iso_27001', 'AC-2'],
  ['soc_2', 'CC6.100'],
  ['soc_2', 'CC0.1'],
  ['soc_2', 'CC10.1'],
  ['soc_2', 'A.5.1'],
  ['soc_2', ''],
];

describe('groupOf and parentCodeOf on a foreign or malformed code (fail safe)', () => {
  it.each(NOT_THE_FRAMEWORKS)('%s: groupOf(%j) names no group of the framework', async (key, code) => {
    const { groupOf, FRAMEWORKS } = await loadFrameworks();
    const result = outcome(() => groupOf(key, code));
    if (!result.threw) {
      expect(Object.hasOwn(FRAMEWORKS[key]!.groupNames, String(result.value)), String(result.value)).toBe(false);
    }
  });

  it.each(NOT_THE_FRAMEWORKS)('%s: parentCodeOf(%j) gives no parent code', async (key, code) => {
    const { parentCodeOf } = await loadFrameworks();
    const result = outcome(() => parentCodeOf(key, code));
    if (!result.threw) expect(result.value).toBeNull();
  });

  it.each(['scf', 'NIST_800_53', '', 'toString', '__proto__'])(
    'an unknown framework key %j gets no group and no parent',
    async (key) => {
      const { groupOf, parentCodeOf, FRAMEWORKS } = await loadFrameworks();
      const group = outcome(() => groupOf(key, 'AC-2(1)'));
      if (!group.threw) {
        const named = Object.values(FRAMEWORKS).some((f) => Object.hasOwn(f.groupNames, String(group.value)));
        expect(named, String(group.value)).toBe(false);
      }
      const parent = outcome(() => parentCodeOf(key, 'AC-2(1)'));
      if (!parent.threw) expect(parent.value).toBeNull();
    },
  );
});

/** Natural order per framework, written out by hand. */
const ORDERED: Record<Key, string[][]> = {
  nist_800_53: [
    [
      'AC-1',
      'AC-2',
      'AC-2(1)',
      'AC-2(2)',
      'AC-2(10)',
      'AC-3',
      'AC-10',
      'AC-17',
      'AC-17(3)',
      'AT-1',
      'AU-2',
      'AU-12',
      'CA-7',
      'PT-2',
      'PT-2(2)',
      'SC-7',
      'SC-7(5)',
      'SC-7(21)',
      'SC-28',
      'SI-2',
      'SI-4',
      'SI-4(2)',
      'SI-4(24)',
      'SR-3',
      'SR-12',
    ],
  ],
  nist_csf_2: [
    ['GV.OC-01', 'GV.OC-02', 'GV.OC-03', 'GV.OC-04', 'GV.OC-05'],
    ['PR.AA-01', 'PR.AA-02', 'PR.AA-05', 'PR.AA-06'],
    ['RS.MA-01', 'RS.MA-02', 'RS.MA-05'],
  ],
  iso_27001: [
    [
      'A.5.1',
      'A.5.2',
      'A.5.9',
      'A.5.10',
      'A.5.37',
      'A.6.1',
      'A.6.8',
      'A.7.1',
      'A.7.14',
      'A.8.1',
      'A.8.2',
      'A.8.9',
      'A.8.10',
      'A.8.34',
    ],
  ],
  soc_2: [
    [
      'CC1.1',
      'CC1.2',
      'CC1.5',
      'CC2.1',
      'CC3.4',
      'CC5.3',
      'CC6.1',
      'CC6.2',
      'CC6.8',
      'CC6.10',
      'CC7.5',
      'CC8.1',
      'CC9.1',
      'CC9.2',
    ],
    ['P1.1', 'P2.1', 'P3.1', 'P3.2', 'P4.3', 'P6.1', 'P6.7', 'P8.1'],
    ['PI1.1', 'PI1.2', 'PI1.5'],
  ],
};

/** A fixed shuffle (the same every run, D171): reversed, then odd positions before even ones. */
function shuffled<T>(list: readonly T[]): T[] {
  const reversed = [...list].reverse();
  return [...reversed.filter((_, i) => i % 2 === 1), ...reversed.filter((_, i) => i % 2 === 0)];
}

function byKey(sortKey: (code: string) => string) {
  return (a: string, b: string) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

describe('criterion 3: sortKeyOf', () => {
  it.each(KEYS.flatMap((key) => ORDERED[key].map((list, i) => [key, i, list] as const)))(
    '%s list %i: a shuffled list sorts into natural order',
    async (key, _i, list) => {
      const { sortKeyOf } = await loadFrameworks();
      const input = shuffled(list);
      expect(input).not.toEqual(list);
      expect(input.sort(byKey((code) => sortKeyOf(key, code)))).toEqual(list);
    },
  );

  it('sorting all the 800-53 examples the brief gives: AC-1, AC-2, AC-2(1), AC-2(10), AC-3, AC-10', async () => {
    const { sortKeyOf } = await loadFrameworks();
    const list = ['AC-1', 'AC-2', 'AC-2(1)', 'AC-2(10)', 'AC-3', 'AC-10'];
    expect(shuffled(list).sort(byKey((code) => sortKeyOf('nist_800_53', code)))).toEqual(list);
  });

  it('keeps each CSF category together, in number order, in a mixed list', async () => {
    const { sortKeyOf } = await loadFrameworks();
    const all = ORDERED.nist_csf_2.flat();
    const sorted = shuffled(all).sort(byKey((code) => sortKeyOf('nist_csf_2', code)));
    for (const category of ORDERED.nist_csf_2) {
      const at = sorted.indexOf(category[0]!);
      expect(sorted.slice(at, at + category.length)).toEqual(category);
    }
  });

  it('keeps each SOC 2 series kind together, in natural order, in a mixed list', async () => {
    const { sortKeyOf } = await loadFrameworks();
    const all = ORDERED.soc_2.flat();
    const sorted = shuffled(all).sort(byKey((code) => sortKeyOf('soc_2', code)));
    for (const run of ORDERED.soc_2) {
      expect(sorted.filter((code) => run.includes(code))).toEqual(run);
    }
  });

  it('returns a string, the same every call', async () => {
    const { sortKeyOf } = await loadFrameworks();
    for (const [key, code] of SAMPLES) {
      const first = sortKeyOf(key, code);
      expect(typeof first).toBe('string');
      expect(sortKeyOf(key, code)).toBe(first);
    }
  });

  it('gives different codes of one framework different keys', async () => {
    const { sortKeyOf } = await loadFrameworks();
    for (const key of KEYS) {
      const codes = ORDERED[key].flat();
      const keys = new Set(codes.map((code) => sortKeyOf(key, code)));
      expect(keys.size, key).toBe(codes.length);
    }
  });
});

// ---- criterion 4: stable IDs ----

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 UUID v5, written here from the RFC, not taken from src. */
function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const REQUIREMENTS = SAMPLES.map(([key, code]) => [key, code] as const);

describe('criterion 4: CATALOG_NAMESPACE', () => {
  it('is a fixed UUID', async () => {
    const { CATALOG_NAMESPACE } = await loadFrameworks();
    expect(CATALOG_NAMESPACE).toMatch(ANY_UUID);
  });
});

describe('criterion 4: the reference UUID v5 used by these tests', () => {
  // RFC 9562's own UUIDv5 example (and RFC 4122's DNS namespace): "www.example.com" in the DNS
  // namespace. It proves the helper above computes v5 correctly, so comparing against it means
  // something.
  it('matches the RFC example', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
});

// "Stable ... the same in every org" (S2 shared notes): once S2-003 loads the catalogs, every org
// graph holds these IDs, and a reload finds its nodes by them. A changed namespace would give every
// framework and requirement a new ID and leave the loaded ones behind, so the values are pinned here.
describe('criterion 4: the IDs never change between releases', () => {
  it('CATALOG_NAMESPACE keeps its value', async () => {
    const { CATALOG_NAMESPACE } = await loadFrameworks();
    expect(CATALOG_NAMESPACE).toBe('d0844755-5c9f-4603-a5c6-9a94211bcc69');
  });

  it.each([
    ['nist_800_53', '8fd34874-b52a-5341-bc4b-b21b31a70d42'],
    ['nist_csf_2', 'e091f678-5586-5af5-a2cc-532e6f8798ac'],
    ['iso_27001', 'aeb6a52d-eee1-5614-8d1f-21a605e2f6fa'],
    ['soc_2', '298b78f1-5bdb-5e22-9053-486e243afa5f'],
  ])('frameworkIdFor(%s) is %s', async (key, id) => {
    const { frameworkIdFor } = await loadFrameworks();
    expect(frameworkIdFor(key)).toBe(id);
  });

  it.each([
    ['nist_800_53', 'AC-2(1)', '35d1ba9f-3411-5ce6-84c9-2a8addaee42b'],
    ['nist_csf_2', 'GV.OC-01', '99da8f99-2d93-5e93-b582-791db5fdb1b9'],
    ['iso_27001', 'A.5.1', '7f4397db-afb7-5641-9b82-59c3750acb00'],
    ['soc_2', 'CC6.1', 'b4dfc692-7d36-5e9b-85a4-079e677165b4'],
  ])('requirementIdFor(%s, %s) is %s', async (key, code, id) => {
    const { requirementIdFor } = await loadFrameworks();
    expect(requirementIdFor(key, code)).toBe(id);
  });
});

describe('criterion 4: frameworkIdFor', () => {
  it.each(KEYS)('%s: the UUID v5 of framework:<key> in CATALOG_NAMESPACE', async (key) => {
    const { frameworkIdFor, CATALOG_NAMESPACE } = await loadFrameworks();
    expect(frameworkIdFor(key)).toBe(uuidV5(CATALOG_NAMESPACE, `framework:${key}`));
  });

  it.each(KEYS)('%s: a lowercase RFC 9562 v5 UUID, the same every call', async (key) => {
    const { frameworkIdFor } = await loadFrameworks();
    const id = frameworkIdFor(key);
    expect(id).toMatch(UUID_V5);
    expect(frameworkIdFor(key)).toBe(id);
  });

  it('gives each framework a different ID', async () => {
    const { frameworkIdFor } = await loadFrameworks();
    expect(new Set(KEYS.map((key) => frameworkIdFor(key))).size).toBe(KEYS.length);
  });
});

describe('criterion 4: requirementIdFor', () => {
  it.each(REQUIREMENTS)('%s %s: the UUID v5 of requirement:<key>:<code> in CATALOG_NAMESPACE', async (key, code) => {
    const { requirementIdFor, CATALOG_NAMESPACE } = await loadFrameworks();
    expect(requirementIdFor(key, code)).toBe(uuidV5(CATALOG_NAMESPACE, `requirement:${key}:${code}`));
  });

  it.each(REQUIREMENTS)('%s %s: a lowercase RFC 9562 v5 UUID, the same every call', async (key, code) => {
    const { requirementIdFor } = await loadFrameworks();
    const id = requirementIdFor(key, code);
    expect(id).toMatch(UUID_V5);
    expect(requirementIdFor(key, code)).toBe(id);
  });

  it('gives every framework and every different requirement a different ID', async () => {
    const { requirementIdFor, frameworkIdFor } = await loadFrameworks();
    const pairs = new Map<string, readonly [Key, string]>();
    for (const [key, code] of REQUIREMENTS) pairs.set(`${key}:${code}`, [key, code]);
    for (const key of KEYS) for (const code of ORDERED[key].flat()) pairs.set(`${key}:${code}`, [key, code]);
    const ids = [
      ...KEYS.map((key) => frameworkIdFor(key)),
      ...[...pairs.values()].map(([key, code]) => requirementIdFor(key, code)),
    ];
    expect(ids.length).toBe(KEYS.length + pairs.size);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the code exactly as given (no re-casing or re-padding, D212 (1))', async () => {
    const { requirementIdFor, CATALOG_NAMESPACE } = await loadFrameworks();
    expect(requirementIdFor('nist_800_53', 'AC-2(1)')).toBe(
      uuidV5(CATALOG_NAMESPACE, 'requirement:nist_800_53:AC-2(1)'),
    );
    expect(requirementIdFor('nist_800_53', 'AC-2(1)')).not.toBe(requirementIdFor('nist_800_53', 'AC-2(01)'));
  });
});
