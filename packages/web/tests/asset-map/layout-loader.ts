// The S1-009 map layout under test (`src/features/records/assets/map-layout.ts`) and the map's
// shapes from the API (S1-005's `GET /api/v1/assets/:id/map`). No DOM needed, so the layout's own
// tests run without jsdom.

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

export interface MapAnswer {
  nodes: MapNode[];
  edges: MapEdge[];
  truncated: boolean;
}

export interface Position {
  x: number;
  y: number;
}

export interface MapLayoutModule {
  /** The size of the box each node is drawn in. */
  MAP_NODE_WIDTH: number;
  MAP_NODE_HEIGHT: number;
  /** A position per node: the top-left corner of its box, as React Flow places nodes. */
  layoutMap: (centreId: string, nodes: readonly MapNode[], edges: readonly MapEdge[]) => Record<string, Position>;
}

// Loaded at run time (not at transform time), so a missing file shows up as failing tests that
// name it, not as a file that can't be collected.
const LAYOUT_FILE = '../../src/features/records/assets/map-layout.ts';

export async function loadLayout(): Promise<MapLayoutModule> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ LAYOUT_FILE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/features/records/assets/map-layout.ts could not be loaded: ${(err as Error).message}`, {
      cause: err,
    });
  }
  for (const name of ['MAP_NODE_WIDTH', 'MAP_NODE_HEIGHT', 'layoutMap'] as const) {
    if (mod[name] === undefined) throw new Error(`map-layout.ts must export \`${name}\``);
  }
  return mod as unknown as MapLayoutModule;
}
