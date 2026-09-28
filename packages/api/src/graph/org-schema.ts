// The D73 schema every org database carries (S1-002; D22, D45.5, D70, D71, D73, D144).
// - Uniqueness on `id` and `number` for the nine record labels.
// - Range indexes for the list filters (`status`, `sensitivity`, `owner`; `assetType`; `framework`).
// - One full-text index over `name` and `sourceIds`, and a 1024-dim cosine vector index on
//   `nameEmbedding` per label: S4's duplicate matching (D70, D71).
// - A `sourceDocId` index on every link type.
// Every statement is `IF NOT EXISTS` with a fixed name, so a re-run changes nothing (D45.5), and
// none names a database (D144): each runs in `org-<orgId>` through GraphService.
import type { ManagedTransaction } from 'neo4j-driver';
import { NODE_RECORD_TYPES } from './privileges.js';

/** The link types that carry a `sourceDocId` (D66, D73). */
const LINK_TYPES = [
  'HOSTS',
  'RUNS',
  'EXPOSED_TO',
  'MITIGATED_BY',
  'GOVERNED_BY',
  'IMPACTS',
  'EXPOSES',
  'SATISFIES',
  'MAPS_TO',
  'SUPPORTS',
  'CONCERNS',
] as const;

const EXTRA_RANGE: readonly { label: string; property: string }[] = [
  { label: 'Asset', property: 'assetType' },
  { label: 'Control', property: 'framework' },
  { label: 'Requirement', property: 'framework' },
];

const VECTOR_DIMENSIONS = 1024;
/** How long to wait for new indexes to come online, in seconds. */
const AWAIT_INDEXES_S = 300;

/** Asset → asset, AuditFinding → audit_finding. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Every schema statement, in order. Pure. */
export function orgSchemaStatements(): string[] {
  const labels = Object.keys(NODE_RECORD_TYPES);
  const out: string[] = [];
  for (const label of labels) {
    for (const prop of ['id', 'number']) {
      out.push(
        `CREATE CONSTRAINT ${snake(label)}_${prop}_unique IF NOT EXISTS FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`,
      );
    }
  }
  for (const label of labels) {
    for (const prop of ['status', 'sensitivity', 'owner']) {
      out.push(`CREATE RANGE INDEX ${snake(label)}_${prop} IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`);
    }
  }
  for (const { label, property } of EXTRA_RANGE) {
    out.push(`CREATE RANGE INDEX ${snake(label)}_${snake(property)} IF NOT EXISTS FOR (n:${label}) ON (n.${property})`);
  }
  out.push(
    `CREATE FULLTEXT INDEX record_names IF NOT EXISTS FOR (n:${labels.join('|')}) ON EACH [n.name, n.sourceIds]`,
  );
  for (const label of labels) {
    out.push(
      `CREATE VECTOR INDEX ${snake(label)}_name_embedding IF NOT EXISTS FOR (n:${label}) ON (n.nameEmbedding) ` +
        `OPTIONS { indexConfig: { \`vector.dimensions\`: ${VECTOR_DIMENSIONS}, \`vector.similarity_function\`: 'cosine' } }`,
    );
  }
  for (const type of LINK_TYPES) {
    out.push(
      `CREATE RANGE INDEX ${type.toLowerCase()}_source_doc IF NOT EXISTS FOR ()-[r:${type}]-() ON (r.sourceDocId)`,
    );
  }
  return out;
}

/** The slice of GraphService this needs: one write transaction in `org-<orgId>`. */
export interface SchemaGraph {
  write<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
}

/** Applies the schema to `org-<orgId>` as grc_writer, then waits until every index is online. */
export async function ensureOrgSchema(graph: SchemaGraph, orgId: string): Promise<void> {
  // Schema commands can't share a transaction with each other's data, so one each.
  for (const statement of orgSchemaStatements()) {
    await graph.write(orgId, async (tx) => {
      await tx.run(statement);
    });
  }
  await graph.write(orgId, async (tx) => {
    await tx.run('CALL db.awaitIndexes($seconds)', { seconds: AWAIT_INDEXES_S });
  });
}
