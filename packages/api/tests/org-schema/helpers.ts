// Shared set-up for the S1-002 org-schema tests (test writer's file, D89/D96). The contract and the
// fixed names are in ./expected.ts.
//
// The schema is read back with SHOW INDEXES and SHOW CONSTRAINTS as the Neo4j Desktop `neo4j`
// account, which the tests use only to check and clean up (M0-004 helpers).
import { expect } from 'vitest';
import { runOn, superDriver } from '../graph/helpers.js';
import { ALL_SCHEMA_NAMES, CONSTRAINTS } from './expected.js';

export interface OrgSchemaModule {
  orgSchemaStatements(): string[];
  ensureOrgSchema(graph: unknown, orgId: string): Promise<void>;
}

// Loaded inside the tests, so a missing module fails each test with a message naming the file.
export async function loadOrgSchema(): Promise<OrgSchemaModule> {
  const mod = (await import('../../src/graph/org-schema.js')) as unknown as Record<string, unknown>;
  for (const name of ['orgSchemaStatements', 'ensureOrgSchema']) {
    if (typeof mod[name] !== 'function') throw new Error(`src/graph/org-schema.ts must export \`${name}\``);
  }
  return mod as unknown as OrgSchemaModule;
}

export interface IndexRow {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
  state: string;
  owningConstraint: string | null;
  options: Record<string, unknown>;
}

export interface ConstraintRow {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
  ownedIndex: string | null;
}

export interface SchemaSnapshot {
  indexes: Map<string, IndexRow>;
  constraints: Map<string, ConstraintRow>;
}

/** Every index and constraint in `org-<orgId>`, by name. */
export async function readSchema(orgId: string): Promise<SchemaSnapshot> {
  const driver = superDriver();
  const database = `org-${orgId}`;
  try {
    const idx = await runOn(
      driver,
      database,
      'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, owningConstraint, options',
    );
    const con = await runOn(
      driver,
      database,
      'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties, ownedIndex',
    );
    return {
      indexes: new Map(idx.map((r) => [String(r['name']), r as unknown as IndexRow])),
      constraints: new Map(con.map((r) => [String(r['name']), r as unknown as ConstraintRow])),
    };
  } finally {
    await driver.close();
  }
}

/** A plain, comparable copy of a snapshot (for "a re-run changes nothing"). */
export function comparable(s: SchemaSnapshot): { indexes: unknown[]; constraints: unknown[] } {
  const byName = <T extends { name: string }>(m: Map<string, T>): T[] =>
    [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { indexes: byName(s.indexes), constraints: byName(s.constraints) };
}

/** The vector index settings from SHOW INDEXES `options`. */
export function vectorConfig(row: IndexRow): { dimensions: number; similarity: string } {
  const config = (row.options?.['indexConfig'] ?? {}) as Record<string, unknown>;
  return {
    dimensions: Number(config['vector.dimensions']),
    similarity: String(config['vector.similarity_function'] ?? '').toLowerCase(),
  };
}

/** Every D73 index and constraint name is present, and every index is ONLINE (criterion 2). */
export function expectFullSchema(s: SchemaSnapshot): void {
  const missingIndexes = ALL_SCHEMA_NAMES.filter((n) => !s.indexes.has(n));
  expect(missingIndexes, 'missing from SHOW INDEXES').toEqual([]);
  const missingConstraints = CONSTRAINTS.map((c) => c.name).filter((n) => !s.constraints.has(n));
  expect(missingConstraints, 'missing from SHOW CONSTRAINTS').toEqual([]);
  const notOnline = ALL_SCHEMA_NAMES.filter((n) => s.indexes.get(n)?.state !== 'ONLINE');
  expect(notOnline, 'indexes not ONLINE').toEqual([]);
}

/** None of the D73 names is present (an org database before its schema is applied). */
export function expectNoSchema(s: SchemaSnapshot): void {
  const present = ALL_SCHEMA_NAMES.filter((n) => s.indexes.has(n) || s.constraints.has(n));
  expect(present, 'D73 names already present').toEqual([]);
}
