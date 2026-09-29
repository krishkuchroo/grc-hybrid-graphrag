// The dependency map's layout (S1-009, D204): pure, so the same map always lands the same way
// (D45.8). The centre asset sits at the origin; each step out along HOSTS and RUNS gets its own
// band of rings around it, and a node sits near the neighbours that brought it onto the map.
//
// No two node boxes can overlap: neighbouring places on a ring, and neighbouring rings, are at least
// one box diagonal apart, so the boxes (all the same size) can never cover each other.

export const MAP_NODE_WIDTH = 224;
export const MAP_NODE_HEIGHT = 76;

export interface MapLayoutNode {
  id: string;
  number: string;
}

export interface MapLayoutEdge {
  fromId: string;
  toId: string;
}

export interface MapPosition {
  x: number;
  y: number;
}

/** The distance kept between any two node places: the box diagonal plus a gap. */
const SPACING = Math.ceil(Math.hypot(MAP_NODE_WIDTH, MAP_NODE_HEIGHT)) + 28;
/** The first place on every ring: straight up. */
const START_ANGLE = -Math.PI / 2;

/** How many places fit on ring `k` (radius k × SPACING) with neighbours at least SPACING apart. */
function ringCapacity(k: number): number {
  const radius = k * SPACING;
  return Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, SPACING / (2 * radius))) + 1e-9));
}

function byNumber(a: MapLayoutNode, b: MapLayoutNode): number {
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The average direction of a set of angles (a circular mean), or null for none. */
function meanAngle(angles: number[]): number | null {
  if (angles.length === 0) return null;
  const x = angles.reduce((s, a) => s + Math.cos(a), 0);
  const y = angles.reduce((s, a) => s + Math.sin(a), 0);
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return angles[0]!;
  return Math.atan2(y, x);
}

/** Angles measured clockwise from straight up, in [0, 2π), so sorting walks round the ring. */
function fromTop(angle: number): number {
  const t = (angle - START_ANGLE) % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/**
 * A position per node: the top-left corner of its box, as React Flow places nodes. The centre is at
 * { x: 0, y: 0 }. Nodes the links don't reach from the centre go on the outermost band.
 */
export function layoutMap(
  centreId: string,
  nodes: readonly MapLayoutNode[],
  edges: readonly MapLayoutEdge[],
): Record<string, MapPosition> {
  const known = new Map(nodes.map((n) => [n.id, n]));
  const out: Record<string, MapPosition> = {};
  if (!known.has(centreId)) return out;

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.fromId) || !known.has(e.toId) || e.fromId === e.toId) continue;
    (neighbours.get(e.fromId) ?? neighbours.set(e.fromId, []).get(e.fromId)!).push(e.toId);
    (neighbours.get(e.toId) ?? neighbours.set(e.toId, []).get(e.toId)!).push(e.fromId);
  }

  // The steps out from the centre, walking the links both ways.
  const steps: MapLayoutNode[][] = [];
  const seen = new Set([centreId]);
  let frontier = [centreId];
  while (frontier.length > 0) {
    const next = new Map<string, MapLayoutNode>();
    for (const id of frontier) {
      for (const other of neighbours.get(id) ?? []) {
        if (!seen.has(other)) next.set(other, known.get(other)!);
      }
    }
    const step = [...next.values()].sort(byNumber);
    for (const n of step) seen.add(n.id);
    if (step.length > 0) steps.push(step);
    frontier = step.map((n) => n.id);
  }
  const unreached = [...known.values()].filter((n) => !seen.has(n.id)).sort(byNumber);
  if (unreached.length > 0) steps.push(unreached);

  out[centreId] = { x: 0, y: 0 };
  const angleOf = new Map<string, number>();
  let ring = 1;
  for (const step of steps) {
    // Order the step round the circle by where its placed neighbours are, so links stay short.
    const ordered = step
      .map((n) => {
        const placed = (neighbours.get(n.id) ?? []).filter((o) => angleOf.has(o)).map((o) => angleOf.get(o)!);
        const mean = meanAngle(placed);
        return { n, key: mean === null ? Number.POSITIVE_INFINITY : fromTop(mean) };
      })
      .sort((a, b) => (a.key !== b.key ? a.key - b.key : byNumber(a.n, b.n)))
      .map((x) => x.n);

    let i = 0;
    while (i < ordered.length) {
      const capacity = ringCapacity(ring);
      const onRing = ordered.slice(i, i + capacity);
      const radius = ring * SPACING;
      // Odd rings start half a place round, so rings don't line up in spokes.
      const offset = ring % 2 === 0 ? 0 : Math.PI / onRing.length;
      onRing.forEach((n, j) => {
        const angle = START_ANGLE + offset + (2 * Math.PI * j) / onRing.length;
        angleOf.set(n.id, angle);
        out[n.id] = { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) };
      });
      i += onRing.length;
      ring += 1;
    }
  }
  return out;
}
