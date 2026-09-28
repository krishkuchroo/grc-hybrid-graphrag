// S1-002 criterion 1 (D73, D70, D71, D45.5, D144): `orgSchemaStatements()` returns the D73 schema
// statements, each `IF NOT EXISTS`, none naming a database. Pure: no database needed.
// The fixed names and the contract are in ./expected.ts.
import { describe, expect, it } from 'vitest';
import { assertNoDatabaseReference } from '../../src/graph/query-guard.js';
import {
  ALL_SCHEMA_NAMES,
  CONSTRAINTS,
  FULLTEXT_INDEX,
  LINK_INDEXES,
  NODE_RANGE_INDEXES,
  RECORD_LABELS,
  VECTOR_DIMENSIONS,
  VECTOR_INDEXES,
} from './expected.js';
import { loadOrgSchema } from './helpers.js';

async function statements(): Promise<string[]> {
  const { orgSchemaStatements } = await loadOrgSchema();
  return orgSchemaStatements();
}

// `CREATE [RANGE|FULLTEXT|VECTOR] INDEX <name> IF NOT EXISTS` or `CREATE CONSTRAINT <name> IF NOT EXISTS`,
// with the name plain or in backticks.
const CREATES =
  /^\s*CREATE\s+(?:(RANGE|FULLTEXT|VECTOR|TEXT|POINT|LOOKUP)\s+)?(INDEX|CONSTRAINT)\s+`?([A-Za-z0-9_]+)`?\s+IF\s+NOT\s+EXISTS\b/i;

interface Created {
  kind: string; // 'RANGE' when no index kind is written (Neo4j's default)
  what: 'INDEX' | 'CONSTRAINT';
  name: string;
  text: string;
}

function parse(text: string): Created | undefined {
  const m = CREATES.exec(text);
  if (!m) return undefined;
  return {
    kind: (m[1] ?? 'RANGE').toUpperCase(),
    what: m[2]!.toUpperCase() as 'INDEX' | 'CONSTRAINT',
    name: m[3]!,
    text,
  };
}

async function byName(): Promise<Map<string, Created>> {
  const out = new Map<string, Created>();
  for (const s of await statements()) {
    const c = parse(s);
    if (c) out.set(c.name, c);
  }
  return out;
}

async function statementFor(name: string): Promise<Created> {
  const found = (await byName()).get(name);
  if (!found) throw new Error(`no statement creates ${name}`);
  return found;
}

// `(x:Label)` or `()-[x:TYPE]-()`, with the property read as `x.prop`, whatever variable is used.
function nodePattern(label: string): RegExp {
  return new RegExp(`FOR\\s*\\(\\s*(\\w+)\\s*:\\s*\`?${label}\`?\\s*\\)`, 'i');
}
function relPattern(type: string): RegExp {
  return new RegExp(
    `FOR\\s*\\(\\s*\\)\\s*-\\s*\\[\\s*(\\w+)\\s*:\\s*\`?${type}\`?\\s*\\]\\s*-\\s*>?\\s*\\(\\s*\\)`,
    'i',
  );
}

describe('orgSchemaStatements: the shape of every statement (criterion 1)', () => {
  it('returns a non-empty list of strings', async () => {
    const list = await statements();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) expect(typeof s).toBe('string');
  });

  it('is pure: two calls return the same statements in the same order', async () => {
    const { orgSchemaStatements } = await loadOrgSchema();
    expect(orgSchemaStatements()).toEqual(orgSchemaStatements());
  });

  it('every statement says IF NOT EXISTS, so a re-run is safe (D45.5)', async () => {
    for (const s of await statements()) expect(s, s).toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
  });

  it('every statement creates one named index or constraint: nothing is dropped or changed', async () => {
    for (const s of await statements()) {
      expect(parse(s), s).toBeDefined();
      expect(s, s).not.toMatch(/\b(DROP|ALTER|DELETE|DETACH|REMOVE|SET)\b/i);
    }
  });

  it('no statement contains USE, and each passes the D144 query guard', async () => {
    for (const s of await statements()) {
      expect(s, s).not.toMatch(/\bUSE\b/i);
      expect(() => assertNoDatabaseReference(s), s).not.toThrow();
    }
  });

  it('creates exactly the D73 names, one statement each, and nothing else', async () => {
    const names = (await statements()).map((s) => parse(s)?.name);
    expect([...names].sort()).toEqual([...ALL_SCHEMA_NAMES].sort());
  });
});

describe('orgSchemaStatements: uniqueness on id and number for all nine labels (criterion 1)', () => {
  it.each(CONSTRAINTS.map((c) => [c.name, c] as const))('%s', async (_name, spec) => {
    const c = await statementFor(spec.name);
    expect(c.what).toBe('CONSTRAINT');
    const m = nodePattern(spec.label).exec(c.text);
    expect(m, c.text).not.toBeNull();
    expect(c.text).toMatch(
      new RegExp(`REQUIRE\\s+\\(?\\s*${m![1]}\\.${spec.property}\\s*\\)?\\s+IS\\s+(NODE\\s+)?UNIQUE`, 'i'),
    );
  });
});

describe('orgSchemaStatements: range indexes for the list filters (criterion 1)', () => {
  it.each(NODE_RANGE_INDEXES.map((i) => [i.name, i] as const))('%s', async (_name, spec) => {
    const c = await statementFor(spec.name);
    expect(c.what).toBe('INDEX');
    expect(c.kind).toBe('RANGE');
    const m = nodePattern(spec.labelOrType).exec(c.text);
    expect(m, c.text).not.toBeNull();
    expect(c.text).toMatch(new RegExp(`ON\\s*\\(\\s*${m![1]}\\.${spec.property}\\s*\\)`, 'i'));
  });
});

describe('orgSchemaStatements: the full-text index for duplicate matching (criterion 1, D70)', () => {
  it(`${FULLTEXT_INDEX} covers name and sourceIds on all nine labels`, async () => {
    const c = await statementFor(FULLTEXT_INDEX);
    expect(c.what).toBe('INDEX');
    expect(c.kind).toBe('FULLTEXT');
    const m = /FOR\s*\(\s*(\w+)\s*:\s*([^)]+)\)/i.exec(c.text);
    expect(m, c.text).not.toBeNull();
    const labels = m![2]!.split('|').map((l) => l.trim().replace(/`/g, ''));
    expect([...labels].sort()).toEqual([...RECORD_LABELS].sort());
    const on = /ON\s+EACH\s*\[([^\]]+)\]/i.exec(c.text);
    expect(on, c.text).not.toBeNull();
    const props = on![1]!.split(',').map((p) => p.trim());
    expect([...props].sort()).toEqual([`${m![1]}.name`, `${m![1]}.sourceIds`].sort());
  });
});

describe('orgSchemaStatements: vector indexes on nameEmbedding, 1024 dims, cosine (criterion 1, D71)', () => {
  it.each(VECTOR_INDEXES.map((i) => [i.name, i] as const))('%s', async (_name, spec) => {
    const c = await statementFor(spec.name);
    expect(c.what).toBe('INDEX');
    expect(c.kind).toBe('VECTOR');
    const m = nodePattern(spec.label).exec(c.text);
    expect(m, c.text).not.toBeNull();
    expect(c.text).toMatch(new RegExp(`ON\\s*\\(?\\s*${m![1]}\\.nameEmbedding\\b`, 'i'));
    expect(c.text).toMatch(new RegExp(`vector\\.dimensions\`?\\s*:\\s*${VECTOR_DIMENSIONS}\\b`, 'i'));
    expect(c.text).toMatch(/vector\.similarity_function`?\s*:\s*['"]cosine['"]/i);
  });
});

describe('orgSchemaStatements: a sourceDocId index on every link type (criterion 1)', () => {
  it.each(LINK_INDEXES.map((i) => [i.name, i] as const))('%s', async (_name, spec) => {
    const c = await statementFor(spec.name);
    expect(c.what).toBe('INDEX');
    expect(c.kind).toBe('RANGE');
    const m = relPattern(spec.labelOrType).exec(c.text);
    expect(m, c.text).not.toBeNull();
    expect(c.text).toMatch(new RegExp(`ON\\s*\\(\\s*${m![1]}\\.sourceDocId\\s*\\)`, 'i'));
  });
});
