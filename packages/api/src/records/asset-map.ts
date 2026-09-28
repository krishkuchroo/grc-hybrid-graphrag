// The asset map (D204): the assets around one asset, following HOSTS and RUNS in both directions,
// 1 to 3 steps out (2 when none is given), and at most MAP_MAX_NODES assets with the centre
// included, then `truncated: true`.
// It walks out one step at a time. Each step's new assets are taken in number order (then ID), so
// the same data gives the same nodes every time (D45.8). Every query keeps to the caller's scope
// (`where`), so a hidden asset never reaches the caller, and neither does an asset reached only
// through a hidden one (D51).
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { z } from 'zod';
import { MAP_DEFAULT_DEPTH, MAP_MAX_DEPTH, MAP_MAX_NODES } from '@grc/shared';

export interface MapNode {
  id: string;
  number: string;
  name: string;
  assetType: string;
  criticality: string;
  label: string;
}

export interface MapEdge {
  type: 'HOSTS' | 'RUNS';
  fromId: string;
  toId: string;
}

export interface AssetMap {
  nodes: MapNode[];
  edges: MapEdge[];
  truncated: boolean;
}

export const mapNodeSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  assetType: z.string(),
  criticality: z.string(),
  label: z.string(),
});

export const assetMapSchema = z.object({
  nodes: z.array(mapNodeSchema),
  edges: z.array(z.object({ type: z.enum(['HOSTS', 'RUNS']), fromId: z.string(), toId: z.string() })),
  truncated: z.boolean(),
});

const depthPattern = new RegExp(`^[1-${MAP_MAX_DEPTH}]$`);

const mapQuerySchema = z.strictObject({
  depth: z.string().regex(depthPattern, `must be a whole number from 1 to ${MAP_MAX_DEPTH}`).optional(),
});

/** The map's depth from the query string: 1 to MAP_MAX_DEPTH, MAP_DEFAULT_DEPTH when none is
 * given. Anything else is refused (a ZodError, answered as 400). */
export function parseMapDepth(query: unknown): number {
  const { depth } = mapQuerySchema.parse(query ?? {});
  return depth === undefined ? MAP_DEFAULT_DEPTH : Number(depth);
}

/** The caller's scope: a Cypher condition on a node variable, with its parameters. */
export interface MapScope {
  where: (variable: string) => string;
  params: Record<string, unknown>;
}

const NODE_FIELDS = (v: string): string =>
  `${v}.id AS id, ${v}.number AS number, ${v}.name AS name, ${v}.assetType AS assetType, ` +
  `${v}.criticality AS criticality, ${v}.sensitivity AS label`;

function toNode(r: { get(key: string): unknown }): MapNode {
  return {
    id: r.get('id') as string,
    number: r.get('number') as string,
    name: r.get('name') as string,
    assetType: r.get('assetType') as string,
    criticality: r.get('criticality') as string,
    label: r.get('label') as string,
  };
}

/** The map around `centreId`, or null when the centre isn't an asset the caller can see. */
export async function buildAssetMap(
  tx: ManagedTransaction,
  centreId: string,
  depth: number,
  scope: MapScope,
): Promise<AssetMap | null> {
  const centre = await tx.run(`MATCH (c:Asset {id: $centreId}) WHERE ${scope.where('c')} RETURN ${NODE_FIELDS('c')}`, {
    ...scope.params,
    centreId,
  });
  const first = centre.records[0];
  if (!first) return null;

  const nodes: MapNode[] = [toNode(first)];
  const seen = new Set([nodes[0]!.id]);
  let frontier = [nodes[0]!.id];
  let truncated = false;
  for (let step = 1; step <= depth && frontier.length > 0; step += 1) {
    const room = MAP_MAX_NODES - nodes.length;
    const found = await tx.run(
      `MATCH (a:Asset)-[:HOSTS|RUNS]-(b:Asset)
       WHERE a.id IN $frontier AND NOT b.id IN $seen AND ${scope.where('b')}
       WITH DISTINCT b
       RETURN ${NODE_FIELDS('b')}
       ORDER BY number, id
       LIMIT $limit`,
      { ...scope.params, frontier, seen: [...seen], limit: neo4j.int(room + 1) },
    );
    const next = found.records.map(toNode);
    if (next.length > room) {
      truncated = true;
      next.length = room;
    }
    for (const node of next) {
      nodes.push(node);
      seen.add(node.id);
    }
    frontier = next.map((n) => n.id);
    if (truncated) break;
  }

  const ids = [...seen];
  const linked = await tx.run(
    `MATCH (a:Asset)-[r:HOSTS|RUNS]->(b:Asset)
     WHERE a.id IN $ids AND b.id IN $ids
     RETURN DISTINCT a.id AS fromId, type(r) AS type, b.id AS toId
     ORDER BY fromId, type, toId`,
    { ids },
  );
  const edges = linked.records.map((r) => ({
    type: r.get('type') as MapEdge['type'],
    fromId: r.get('fromId') as string,
    toId: r.get('toId') as string,
  }));
  return { nodes, edges, truncated };
}
