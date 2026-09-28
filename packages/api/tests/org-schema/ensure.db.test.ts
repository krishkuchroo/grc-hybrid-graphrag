// S1-002 criteria 2–5 and 7 (D73, D70, D71, D22, D45.5, D133, D176): `ensureOrgSchema` gives an
// org database the D73 schema, a re-run changes nothing, the database refuses duplicate `id` and
// `number` values, and `provisionOrg` applies the schema to new orgs.
// The fixed names and the contract are in ./expected.ts.
//
// Throwaway data (D82, D176): a throwaway Postgres database (the M0-014 provision helpers) and
// throwaway `org-<uuid>` Neo4j databases, all dropped in afterAll. Nothing shared is changed: the
// Desktop `neo4j` account only reads the schema and privileges back, and cleans up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDatabases, graphTestEnv, driverAs, refused, runOn, superDriver } from '../graph/helpers.js';
import {
  deps,
  loadProvisionOrg,
  newOrgInput,
  setUpProvision,
  tearDownProvision,
  type ProvEnv,
} from '../provision/helpers.js';
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
import {
  comparable,
  expectFullSchema,
  loadOrgSchema,
  readSchema,
  vectorConfig,
  type SchemaSnapshot,
} from './helpers.js';

const T = 180_000;

let env: ProvEnv;
/** An org database made directly with createOrgDatabase: no Postgres org, no schema yet. */
const orgId = randomUUID();
const extraDatabases = new Set<string>([`org-${orgId}`]);

beforeAll(async () => {
  env = await setUpProvision();
  await env.graph.createOrgDatabase(orgId);
}, T);

afterAll(async () => {
  const driver = superDriver();
  try {
    await dropDatabases(driver, extraDatabases);
  } finally {
    await driver.close();
    await tearDownProvision(env);
  }
}, T);

// The first ensureOrgSchema on the throwaway org, run once and shared by the checks that need it.
// Called inside each test, so a missing module or a failure shows up in every test that depends on it.
let applied: Promise<SchemaSnapshot> | undefined;
function schemaApplied(): Promise<SchemaSnapshot> {
  applied ??= (async () => {
    const { ensureOrgSchema } = await loadOrgSchema();
    await ensureOrgSchema(env.graph, orgId);
    return readSchema(orgId);
  })();
  return applied;
}

describe('ensureOrgSchema: every expected name is listed and ONLINE (criterion 2)', { timeout: T }, () => {
  it('SHOW INDEXES lists every D73 name, each ONLINE', async () => {
    const s = await schemaApplied();
    const missing = ALL_SCHEMA_NAMES.filter((n) => !s.indexes.has(n));
    expect(missing, 'missing from SHOW INDEXES').toEqual([]);
    const notOnline = ALL_SCHEMA_NAMES.filter((n) => s.indexes.get(n)?.state !== 'ONLINE');
    expect(notOnline, 'not ONLINE').toEqual([]);
  });

  it.each(CONSTRAINTS.map((c) => [c.name, c] as const))(
    'SHOW CONSTRAINTS lists %s: uniqueness on one label and property, its index ONLINE',
    async (name, spec) => {
      const s = await schemaApplied();
      const c = s.constraints.get(name);
      expect(c, `${name} missing from SHOW CONSTRAINTS`).toBeDefined();
      expect(c!.type).toMatch(/UNIQUENESS$/);
      expect(c!.entityType).toBe('NODE');
      expect(c!.labelsOrTypes).toEqual([spec.label]);
      expect(c!.properties).toEqual([spec.property]);
      expect(s.indexes.get(c!.ownedIndex ?? '')?.state).toBe('ONLINE');
    },
  );

  it.each(NODE_RANGE_INDEXES.map((i) => [i.name, i] as const))(
    '%s is a node range index on its label and property',
    async (name, spec) => {
      const i = (await schemaApplied()).indexes.get(name);
      expect(i, `${name} missing`).toBeDefined();
      expect(i).toMatchObject({
        type: 'RANGE',
        entityType: 'NODE',
        labelsOrTypes: [spec.labelOrType],
        properties: [spec.property],
        state: 'ONLINE',
      });
    },
  );

  it(`${FULLTEXT_INDEX} is a full-text index on name and sourceIds over all nine labels (D70)`, async () => {
    const i = (await schemaApplied()).indexes.get(FULLTEXT_INDEX);
    expect(i, `${FULLTEXT_INDEX} missing`).toBeDefined();
    expect(i!.type).toBe('FULLTEXT');
    expect(i!.entityType).toBe('NODE');
    expect([...i!.labelsOrTypes].sort()).toEqual([...RECORD_LABELS].sort());
    expect([...i!.properties].sort()).toEqual(['name', 'sourceIds']);
    expect(i!.state).toBe('ONLINE');
  });

  it.each(VECTOR_INDEXES.map((i) => [i.name, i] as const))(
    '%s is a vector index on nameEmbedding, 1024 dimensions, cosine (D71)',
    async (name, spec) => {
      const i = (await schemaApplied()).indexes.get(name);
      expect(i, `${name} missing`).toBeDefined();
      expect(i).toMatchObject({
        type: 'VECTOR',
        entityType: 'NODE',
        labelsOrTypes: [spec.label],
        properties: ['nameEmbedding'],
        state: 'ONLINE',
      });
      expect(vectorConfig(i!)).toEqual({ dimensions: VECTOR_DIMENSIONS, similarity: 'cosine' });
    },
  );

  it.each(LINK_INDEXES.map((i) => [i.name, i] as const))(
    '%s is a relationship range index on sourceDocId',
    async (name, spec) => {
      const i = (await schemaApplied()).indexes.get(name);
      expect(i, `${name} missing`).toBeDefined();
      expect(i).toMatchObject({
        type: 'RANGE',
        entityType: 'RELATIONSHIP',
        labelsOrTypes: [spec.labelOrType],
        properties: ['sourceDocId'],
        state: 'ONLINE',
      });
    },
  );
});

describe('ensureOrgSchema: a re-run changes nothing and throws nothing (criterion 3, D45.5)', { timeout: T }, () => {
  it('a second and a third run resolve, and SHOW INDEXES and SHOW CONSTRAINTS are unchanged', async () => {
    const before = await schemaApplied();
    const { ensureOrgSchema } = await loadOrgSchema();
    await expect(ensureOrgSchema(env.graph, orgId)).resolves.toBeUndefined();
    await expect(ensureOrgSchema(env.graph, orgId)).resolves.toBeUndefined();
    const after = await readSchema(orgId);
    expect(comparable(after)).toEqual(comparable(before));
  });
});

describe(
  'ensureOrgSchema: the database refuses a second node with the same id or number (criterion 4)',
  {
    timeout: T,
  },
  () => {
    // Written as grc_writer, the account every record write uses (D57, D73).
    const cases = RECORD_LABELS.flatMap((label) => (['number', 'id'] as const).map((prop) => [label, prop] as const));

    it.each(cases)('%s: a duplicate %s is refused, and only the first node is kept', async (label, prop) => {
      await schemaApplied();
      const g = graphTestEnv();
      const writer = driverAs('grc_writer', g.writerPassword);
      const database = `org-${orgId}`;
      const shared = `dup-${prop}-${label}-${randomUUID()}`;
      const first = prop === 'id' ? { id: shared, number: `N-${randomUUID()}` } : { id: randomUUID(), number: shared };
      const second = prop === 'id' ? { id: shared, number: `N-${randomUUID()}` } : { id: randomUUID(), number: shared };
      try {
        await runOn(writer, database, `CREATE (n:${label}) SET n = $props, n.sensitivity = 'internal'`, {
          props: first,
        });
        const err = await refused(
          runOn(writer, database, `CREATE (n:${label}) SET n = $props, n.sensitivity = 'internal'`, { props: second }),
        );
        expect(err.code).toBe('Neo.ClientError.Schema.ConstraintValidationFailed');
        const sup = superDriver();
        try {
          const rows = await runOn(sup, database, `MATCH (n:${label}) WHERE n.${prop} = $v RETURN count(n) AS n`, {
            v: shared,
          });
          expect(rows[0]?.['n']).toBe(1);
        } finally {
          await sup.close();
        }
      } finally {
        await writer.close();
      }
    });
  },
);

describe('provisionOrg gives a new org the schema, and a re-run stays safe (criterion 5, D133)', { timeout: T }, () => {
  it('a new org has every expected name ONLINE after provisionOrg', async () => {
    const provision = await loadProvisionOrg();
    const { orgId: provisioned } = await provision(newOrgInput('schema'), deps(env));
    expectFullSchema(await readSchema(provisioned));
  });

  it('provisionOrg run again with the same slug resolves with the same org, and its schema is unchanged', async () => {
    const provision = await loadProvisionOrg();
    const input = newOrgInput('schemarerun');
    const first = await provision(input, deps(env));
    const before = await readSchema(first.orgId);
    expectFullSchema(before);
    const second = await provision(input, deps(env));
    expect(second.orgId).toBe(first.orgId);
    expect(comparable(await readSchema(first.orgId))).toEqual(comparable(before));
  });
});

describe("ensureOrgSchema leaves the query accounts' privileges alone (criterion 7, D176)", { timeout: T }, () => {
  it('SHOW PRIVILEGES for every grc_ro_* role is the same before and after', async () => {
    const privileges = async (): Promise<string[]> => {
      const sup = superDriver();
      try {
        const rows = await runOn(sup, 'system', 'SHOW PRIVILEGES AS COMMANDS');
        return rows
          .map((r) => String(r['command']))
          .filter((c) => /\bgrc_ro_/.test(c))
          .sort();
      } finally {
        await sup.close();
      }
    };
    const before = await privileges();
    expect(before.length).toBeGreaterThan(0);
    const fresh = randomUUID();
    extraDatabases.add(`org-${fresh}`);
    await env.graph.createOrgDatabase(fresh);
    const { ensureOrgSchema } = await loadOrgSchema();
    await ensureOrgSchema(env.graph, fresh);
    expect(await privileges()).toEqual(before);
  });
});
