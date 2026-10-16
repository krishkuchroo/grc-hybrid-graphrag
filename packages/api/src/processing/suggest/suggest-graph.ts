// The graph reads of a mapping-suggestion run (S4-009; D15, D45.3, D50, D51, D52.1, D70, D73). Every
// read runs as the read-only account of the run's starter (their role x clearance, `readAs`), with
// a time limit, in the org's own database, so Neo4j hides every record type the role can't view,
// every node above the clearance and every link with a hidden end; each query also keeps to
// `sensitivity IN <labels at or below the clearance>` and active records, and our code checks the
// labels again. Every name put into the Cypher text comes from the fixed tables below; every value
// goes in as a parameter (D52.2).
// - The items: each active control the starter can see (a `controls` run), or each active SOC 2
//   criterion (a `soc2_to_nist` run), with whether it has a name embedding yet.
// - The candidates: the closest active items of the target framework by name embedding, through
//   the `requirement_name_embedding` vector index (cosine). The index holds every framework's
//   requirements, so the query asks for more neighbours than it keeps and widens until it has its
//   five of the target framework or has looked at every embedded requirement.
// - The pairs already linked: SATISFIES from the control, or MAPS_TO either way between the two
//   requirements.
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { isLabel, isVisible, type FrameworkKey, type Label, type Role } from '@grc/shared';
import type { GraphService } from '../../graph/graph.service.js';
import { visibleLabels } from '../../records/record-queries.js';
import type { MappingSuggestKind } from '../queues.js';

/** Neo4j stops each read of a run after this long (D15, D48). */
export const SUGGEST_READ_TIMEOUT_MS = 10_000;

/** The first number of neighbours asked of the vector index; it grows 4 times each step. */
export const FIRST_NEIGHBOURS = 50;
const NEIGHBOUR_GROWTH = 4;

/** The vector index on requirement names (org-schema.ts: `<label>_name_embedding`). */
const REQUIREMENT_INDEX = 'requirement_name_embedding';

/** The node label of each kind's items, and the link it suggests. */
const ITEM_LABEL: Readonly<Record<MappingSuggestKind, 'Control' | 'Requirement'>> = {
  controls: 'Control',
  soc2_to_nist: 'Requirement',
};

/** The framework a `soc2_to_nist` run reads its items from, and the one it links them to. */
export const SOC2_FRAMEWORK: FrameworkKey = 'soc_2';
export const NIST_800_53_FRAMEWORK: FrameworkKey = 'nist_800_53';

/** Whose view a run's reads are made in. */
export interface SuggestViewer {
  userId: string;
  role: Role;
  clearance: Label;
}

/** An item a suggestion is asked for. */
export interface SuggestItem {
  id: string;
  number: string;
  label: Label;
  /** The control's owner (controls only). */
  owner: string | null;
  /** For a control: its name. For a criterion: its title. */
  name: string;
  code: string | null;
  /** A control's Source note, or a criterion's description. */
  detail: string | null;
  embedded: boolean;
}

/** A catalog item an item may map to. */
export interface SuggestCandidate {
  id: string;
  number: string;
  label: Label;
  code: string;
  title: string;
  description: string | null;
  score: number;
}

export type SuggestGraph = Pick<GraphService, 'readAs'>;

function read<T>(
  graph: SuggestGraph,
  orgId: string,
  viewer: SuggestViewer,
  fn: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  return graph.readAs(orgId, viewer.role, viewer.clearance, fn, { timeoutMs: SUGGEST_READ_TIMEOUT_MS });
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** The run's items, in number order (controls) or catalog order (criteria). Nodes whose label isn't
 * one of the four, or is above the clearance, are left out by our code too. */
export async function readItems(
  graph: SuggestGraph,
  orgId: string,
  viewer: SuggestViewer,
  kind: MappingSuggestKind,
): Promise<SuggestItem[]> {
  const visible = visibleLabels(viewer.clearance);
  const cypher =
    kind === 'controls'
      ? `MATCH (c:Control) WHERE c.status = 'active' AND c.sensitivity IN $visible
         RETURN c.id AS id, c.number AS number, c.sensitivity AS label, c.owner AS owner, c.name AS name,
           c.code AS code, c.framework AS detail, c.nameEmbedding IS NOT NULL AS embedded
         ORDER BY c.number, c.id`
      : `MATCH (q:Requirement {framework: $framework}) WHERE q.status = 'active' AND q.sensitivity IN $visible
         RETURN q.id AS id, q.number AS number, q.sensitivity AS label, null AS owner, q.title AS name,
           q.code AS code, q.description AS detail, q.nameEmbedding IS NOT NULL AS embedded
         ORDER BY q.sortKey, q.code, q.id`;
  const rows = await read(graph, orgId, viewer, async (tx) => {
    const res = await tx.run(cypher, { visible, framework: SOC2_FRAMEWORK });
    return res.records.map((r) => r.toObject() as Record<string, unknown>);
  });
  const items: SuggestItem[] = [];
  for (const r of rows) {
    const label = r['label'];
    const id = text(r['id']);
    const number = text(r['number']);
    if (!id || !number || !isLabel(label) || !isVisible(viewer.clearance, label)) continue;
    items.push({
      id,
      number,
      label,
      owner: text(r['owner']),
      name: text(r['name']) ?? '',
      code: text(r['code']),
      detail: text(r['detail']),
      embedded: r['embedded'] === true,
    });
  }
  return items;
}

/** How many requirements the vector index can answer with (those with a name embedding), and how
 * many active items of the target framework the starter can see have none yet. */
export async function readCatalogEmbeddingCounts(
  graph: SuggestGraph,
  orgId: string,
  viewer: SuggestViewer,
  target: FrameworkKey,
): Promise<{ embedded: number; targetMissing: number }> {
  return read(graph, orgId, viewer, async (tx) => {
    const all = await tx.run(
      `MATCH (q:Requirement) WHERE q.nameEmbedding IS NOT NULL AND q.sensitivity IN $visible RETURN count(q) AS n`,
      { visible: visibleLabels(viewer.clearance) },
    );
    const missing = await tx.run(
      `MATCH (q:Requirement {framework: $framework})
       WHERE q.status = 'active' AND q.sensitivity IN $visible AND q.nameEmbedding IS NULL
       RETURN count(q) AS n`,
      { framework: target, visible: visibleLabels(viewer.clearance) },
    );
    return {
      embedded: Number(all.records[0]?.get('n') ?? 0),
      targetMissing: Number(missing.records[0]?.get('n') ?? 0),
    };
  });
}

/** The `limit` closest active items of `target` to the item by name embedding, best first. Asks
 * the index for `FIRST_NEIGHBOURS`, then 4 times as many, until it has `limit` of the target
 * framework or has asked for every embedded requirement (`indexSize`). */
export async function readCandidates(
  graph: SuggestGraph,
  orgId: string,
  viewer: SuggestViewer,
  input: { kind: MappingSuggestKind; itemId: string; target: FrameworkKey; limit: number; indexSize: number },
): Promise<SuggestCandidate[]> {
  if (input.indexSize <= 0 || input.limit <= 0) return [];
  const cypher = `MATCH (item:${ITEM_LABEL[input.kind]} {id: $id}) WHERE item.nameEmbedding IS NOT NULL
    CALL db.index.vector.queryNodes($index, $k, item.nameEmbedding) YIELD node, score
    WITH node, score
    WHERE node:Requirement AND node.framework = $framework AND node.status = 'active'
      AND node.sensitivity IN $visible AND node.id <> $id
    RETURN node.id AS id, node.number AS number, node.sensitivity AS label, node.code AS code,
      node.title AS title, node.description AS description, score
    ORDER BY score DESC, node.id
    LIMIT $limit`;
  const visible = visibleLabels(viewer.clearance);
  let k = Math.min(FIRST_NEIGHBOURS, input.indexSize);
  for (;;) {
    const rows = await read(graph, orgId, viewer, async (tx) => {
      const res = await tx.run(cypher, {
        id: input.itemId,
        index: REQUIREMENT_INDEX,
        k: neo4j.int(Math.max(k, input.limit)),
        framework: input.target,
        visible,
        limit: neo4j.int(input.limit),
      });
      return res.records.map((r) => r.toObject() as Record<string, unknown>);
    });
    const candidates: SuggestCandidate[] = [];
    for (const r of rows) {
      const label = r['label'];
      const id = text(r['id']);
      const number = text(r['number']);
      const code = text(r['code']);
      if (!id || !number || !code || !isLabel(label) || !isVisible(viewer.clearance, label)) continue;
      candidates.push({
        id,
        number,
        label,
        code,
        title: text(r['title']) ?? '',
        description: text(r['description']),
        score: Number(r['score'] ?? 0),
      });
    }
    if (candidates.length >= input.limit || k >= input.indexSize) return candidates.slice(0, input.limit);
    k = Math.min(k * NEIGHBOUR_GROWTH, input.indexSize);
  }
}

/** Which of `candidateIds` the item is already linked to: SATISFIES from a control, or MAPS_TO
 * either way between two requirements, whatever the link's origin. */
export async function readLinked(
  graph: SuggestGraph,
  orgId: string,
  viewer: SuggestViewer,
  input: { kind: MappingSuggestKind; itemId: string; candidateIds: string[] },
): Promise<Set<string>> {
  if (input.candidateIds.length === 0) return new Set();
  const cypher =
    input.kind === 'controls'
      ? `MATCH (:Control {id: $id})-[:SATISFIES]->(q:Requirement) WHERE q.id IN $ids RETURN DISTINCT q.id AS id`
      : `MATCH (:Requirement {id: $id})-[:MAPS_TO]-(q:Requirement) WHERE q.id IN $ids RETURN DISTINCT q.id AS id`;
  return read(graph, orgId, viewer, async (tx) => {
    const res = await tx.run(cypher, { id: input.itemId, ids: input.candidateIds });
    return new Set(res.records.map((r) => r.get('id') as string));
  });
}
