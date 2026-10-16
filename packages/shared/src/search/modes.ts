// Search modes and paths (D46; S6 shared notes, "Two modes"): `hybrid` runs both paths, vector search
// over the document passages (Path A) and the AI-written graph query (Path B), and fuses them; it is
// the default. `vector` runs Path A only: the benchmark's baseline (S8).

export const SEARCH_MODES = ['hybrid', 'vector'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** The mode when none is given. */
export const DEFAULT_SEARCH_MODE: SearchMode = 'hybrid';

export function isSearchMode(v: unknown): v is SearchMode {
  return typeof v === 'string' && (SEARCH_MODES as readonly string[]).includes(v);
}

/** The two paths a result can be found by: `vector` (Path A) and `graph` (Path B). */
export const SEARCH_PATHS = ['vector', 'graph'] as const;
export type SearchPath = (typeof SEARCH_PATHS)[number];

export function isSearchPath(v: unknown): v is SearchPath {
  return typeof v === 'string' && (SEARCH_PATHS as readonly string[]).includes(v);
}
