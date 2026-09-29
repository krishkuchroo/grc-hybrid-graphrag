// S1-009 criterion 6: the map's layout (`src/features/records/assets/map-layout.ts`) is pure: the
// centre's ID, the nodes and the edges in, a position per node out. It gives the same layout for
// the same input (D45.8, repeatable results), keeps the centre asset in the middle, and never lets
// two nodes overlap, for any map the API can send: up to MAP_MAX_NODES assets, up to MAP_MAX_DEPTH
// steps out (D204).
//
// The contract (S1-009 brief, "nodes and edges in, positions out"):
//   MAP_NODE_WIDTH, MAP_NODE_HEIGHT: the size of the box each node is drawn in.
//   layoutMap(centreId, nodes, edges): Record<assetId, { x, y }>, each the top-left corner of the
//   node's box, as React Flow places nodes. The centre is at { x: 0, y: 0 }.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAP_MAX_NODES } from '@grc/shared';
import { loadLayout, type MapEdge, type MapNode, type Position } from './layout-loader';

afterEach(() => {
  vi.restoreAllMocks();
});

const TYPES = ['server', 'application', 'database', 'network_device', 'cloud_service', 'endpoint'];
const CRITICALITIES = ['low', 'medium', 'high', 'critical'];

function node(n: number): MapNode {
  return {
    id: `00000000-0000-4000-8000-4${String(n).padStart(11, '0')}`,
    number: `AST${String(1000 + n).padStart(7, '0')}`,
    name: `Asset ${n}`,
    assetType: TYPES[n % TYPES.length]!,
    criticality: CRITICALITIES[n % CRITICALITIES.length]!,
    label: 'internal',
  };
}

interface Graph {
  name: string;
  centreId: string;
  nodes: MapNode[];
  edges: MapEdge[];
}

/**
 * A map shaped like the API's answer: the centre first, then each step's assets. `widths[i]` is how
 * many new assets step i+1 adds; each hangs off an asset of the step before (spread evenly), and
 * links alternate HOSTS and RUNS and point both ways.
 */
function rings(name: string, widths: number[], extra: (nodes: MapNode[]) => MapEdge[] = () => []): Graph {
  let n = 1;
  const nodes: MapNode[] = [node(n)];
  const edges: MapEdge[] = [];
  let previous = [nodes[0]!];
  for (const width of widths) {
    const step: MapNode[] = [];
    for (let i = 0; i < width; i += 1) {
      n += 1;
      const b = node(n);
      const parent = previous[Math.floor((i * previous.length) / width)]!;
      step.push(b);
      edges.push(
        n % 2 === 0
          ? { type: 'HOSTS', fromId: parent.id, toId: b.id }
          : { type: 'RUNS', fromId: b.id, toId: parent.id },
      );
    }
    nodes.push(...step);
    previous = step;
  }
  edges.push(...extra(nodes));
  return { name, centreId: nodes[0]!.id, nodes, edges };
}

/** Every map shape the tests lay out. None has more than MAP_MAX_NODES assets or MAP_MAX_DEPTH steps. */
function shapes(): Graph[] {
  return [
    rings('the centre alone', []),
    rings('the centre and one neighbour', [1]),
    rings('a small map', [3, 2, 1]),
    rings('a star of 199 around the centre', [MAP_MAX_NODES - 1]),
    rings('two steps: 14 then 185', [14, MAP_MAX_NODES - 15]),
    rings('three steps: 3, 21, 175', [3, 21, MAP_MAX_NODES - 25]),
    rings('one neighbour with 198 behind it', [1, MAP_MAX_NODES - 2]),
    rings('a long thin map', [1, 1, 1]),
    rings('three steps, widest at the end: 5, 40, 154', [5, 40, MAP_MAX_NODES - 46], (nodes) =>
      // Cross links: step-one assets host each other, and step-two assets link to two parents.
      [
        { type: 'HOSTS', fromId: nodes[1]!.id, toId: nodes[2]!.id },
        { type: 'RUNS', fromId: nodes[3]!.id, toId: nodes[4]!.id },
        ...nodes.slice(6, 46).map((b, i): MapEdge => ({ type: 'HOSTS', fromId: nodes[1 + (i % 5)]!.id, toId: b.id })),
      ],
    ),
  ];
}

function boxesOverlap(a: Position, b: Position, width: number, height: number): boolean {
  return Math.abs(a.x - b.x) < width && Math.abs(a.y - b.y) < height;
}

describe('layoutMap', () => {
  it('exports a node box size and a layout function', async () => {
    const { MAP_NODE_WIDTH, MAP_NODE_HEIGHT, layoutMap } = await loadLayout();
    expect(MAP_NODE_WIDTH).toBeGreaterThan(0);
    expect(MAP_NODE_HEIGHT).toBeGreaterThan(0);
    expect(typeof layoutMap).toBe('function');
  });

  it('gives every node one finite position, and no position for anything else', async () => {
    const { layoutMap } = await loadLayout();
    for (const g of shapes()) {
      const out = layoutMap(g.centreId, g.nodes, g.edges);
      expect(Object.keys(out).sort(), g.name).toEqual(g.nodes.map((n) => n.id).sort());
      for (const n of g.nodes) {
        const p = out[n.id]!;
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), `${g.name}: ${n.number}`).toBe(true);
      }
    }
  });

  it('puts the centre asset at the origin', async () => {
    const { layoutMap } = await loadLayout();
    for (const g of shapes()) {
      expect(layoutMap(g.centreId, g.nodes, g.edges)[g.centreId], g.name).toEqual({ x: 0, y: 0 });
    }
  });

  it('keeps the centre in the middle: other nodes on every side of it', async () => {
    const { layoutMap } = await loadLayout();
    for (const g of shapes().filter((s) => s.nodes.length >= 5)) {
      const out = layoutMap(g.centreId, g.nodes, g.edges);
      const others = g.nodes.filter((n) => n.id !== g.centreId).map((n) => out[n.id]!);
      expect(
        others.some((p) => p.x < 0),
        `${g.name}: something left of the centre`,
      ).toBe(true);
      expect(
        others.some((p) => p.x > 0),
        `${g.name}: something right of the centre`,
      ).toBe(true);
      expect(
        others.some((p) => p.y < 0),
        `${g.name}: something above the centre`,
      ).toBe(true);
      expect(
        others.some((p) => p.y > 0),
        `${g.name}: something below the centre`,
      ).toBe(true);
    }
  });

  it('never lets two nodes overlap, up to 200 assets', async () => {
    const { MAP_NODE_WIDTH, MAP_NODE_HEIGHT, layoutMap } = await loadLayout();
    for (const g of shapes()) {
      const out = layoutMap(g.centreId, g.nodes, g.edges);
      const placed = g.nodes.map((n) => ({ n, p: out[n.id]! }));
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = placed[i]!;
          const b = placed[j]!;
          if (boxesOverlap(a.p, b.p, MAP_NODE_WIDTH, MAP_NODE_HEIGHT)) {
            expect.fail(
              `${g.name}: ${a.n.number} at (${a.p.x}, ${a.p.y}) overlaps ${b.n.number} at (${b.p.x}, ${b.p.y})`,
            );
          }
        }
      }
    }
  });

  it('gives the same layout for the same input, every time', async () => {
    const { layoutMap } = await loadLayout();
    for (const g of shapes()) {
      const first = layoutMap(g.centreId, g.nodes, g.edges);
      const again = layoutMap(g.centreId, g.nodes, g.edges);
      // Fresh copies of the same data, as a second fetch of the same map would give.
      const copy = structuredClone(g);
      const fromCopy = layoutMap(copy.centreId, copy.nodes, copy.edges);
      expect(again, g.name).toEqual(first);
      expect(fromCopy, g.name).toEqual(first);
    }
  });

  it('doesn’t depend on chance or the clock', async () => {
    const { layoutMap } = await loadLayout();
    const g = shapes().find((s) => s.name.startsWith('three steps: 3'))!;
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = layoutMap(g.centreId, g.nodes, g.edges);
    random.mockReturnValue(0.9);
    now.mockReturnValue(9_999_999);
    const second = layoutMap(g.centreId, g.nodes, g.edges);
    expect(second).toEqual(first);
  });

  it('doesn’t change its input', async () => {
    const { layoutMap } = await loadLayout();
    const g = shapes().find((s) => s.name.startsWith('three steps, widest'))!;
    const before = structuredClone(g);
    layoutMap(g.centreId, g.nodes, g.edges);
    expect(g).toEqual(before);
  });
});
