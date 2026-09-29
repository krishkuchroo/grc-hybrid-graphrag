// Shared set-up for the S1-009 tests: the asset dependency map (screen 5, D27) on the asset page,
// drawn with React Flow (D33), around one asset along HOSTS and RUNS (D204).
//
// The API is mocked at the client boundary, like `tests/records/helpers.tsx`: `fetch` is replaced by
// a fake, so the app's client runs for real and every request is recorded. The fake follows the
// real API (S1-004, S1-005):
// - GET /api/v1/me answers the signed-in person; GET /api/v1/people the org's members, paged.
// - GET /api/v1/assets/:id answers the asset, or 404 `not_found` when missing or above the
//   caller's clearance (D51).
// - GET /api/v1/assets/:id/map?depth=<n> is S1-005's map (`packages/api/src/records/asset-map.ts`):
//   `depth` is 1, 2 or 3 and defaults to MAP_DEFAULT_DEPTH; any other value or parameter is 400.
//   It walks out one step at a time along HOSTS and RUNS in both directions, takes each step's new
//   assets in number order, keeps only assets the caller can see, and stops at MAP_MAX_NODES assets
//   (the centre included, and first) with `truncated: true`. The answer is
//   `{ nodes: [{ id, number, name, assetType, criticality, label }], edges: [{ type, fromId, toId }],
//   truncated }`, with every HOSTS or RUNS link between two of the nodes.
// - GET /api/v1/assets/:id/links answers the asset's HOSTS and RUNS links (S1-005's shape), in case
//   the page shows related records (S1-012).
// - Errors use the one D47 format with a reference ID.
//
// Contract with the app (S1-009 brief):
// - The asset page `/assets/$id` has a "Dependency map": a tab named "Dependency map" that shows a
//   tab panel, or a section named "Dependency map" (a region, like the kit's panels). The helper
//   `openMap` handles both.
// - In it, a choice field labelled "Depth" (a native select or a shadcn/Radix select) offers
//   exactly 1, 2 and 3 (each option's text starts with its number) and starts at 2.
// - The map is React Flow (`@xyflow/react`). Each asset is one node whose React Flow id is the
//   asset's id, so it is `[data-testid="rf__node-<asset id>"]`. Each node is drawn in a box of
//   MAP_NODE_WIDTH × MAP_NODE_HEIGHT (the node's `width`/`height` or style), at the position
//   `layoutMap` gives it (React Flow's default node origin, so the node is at
//   `translate(<x>px,<y>px)`).
// - A node shows the asset's number, name and type in words (`network_device` as "Network device"),
//   and its criticality in words ("Critical", "High", …) as text or as an aria-label or title.
// - Each link is one React Flow edge from `fromId` (source) to `toId` (target): its label is the
//   link type, HOSTS or RUNS, and it has an arrow at its end (`markerEnd`), none at its start. Its
//   aria-label names the two ends in order, by ID (React Flow's own "Edge from <fromId> to
//   <toId>") or by number.
// - Clicking a node opens that asset's page, `/assets/<id>`.
// - With `truncated: true` the map says it was cut short at MAP_MAX_NODES assets.
// - An asset with no HOSTS or RUNS links shows a friendly empty state ("No dependencies…").
// - A failed map request shows the API's message and reference ID, and the rest of the asset page
//   stays.
//
// React Flow measures its nodes with ResizeObserver, DOMMatrixReadOnly and offsetWidth/Height,
// which jsdom lacks; the stubs below stand in for them (React Flow's own testing notes).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import { formatNumber, isVisible, MAP_DEFAULT_DEPTH, MAP_MAX_DEPTH, MAP_MAX_NODES, type Label } from '@grc/shared';
import { App } from '../../src/app/App';
// The S1-006 set-up: its Radix shims and choice-field helpers.
import { PEOPLE, type Person, type User } from '../records/helpers';
import type { MapAnswer, MapEdge, MapNode, Position } from './layout-loader';

export { choose, optionsOf, type User } from '../records/helpers';

// ---- jsdom stubs for React Flow ------------------------------------------------------------------

/** Reports each observed element once, all together on the next turn, like the browser does. */
class StubResizeObserver {
  private readonly seen = new WeakSet<Element>();
  private pending: Element[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    if (this.seen.has(target)) return;
    this.seen.add(target);
    this.pending.push(target);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const entries = this.pending.splice(0).map((t) => {
        const el = t as HTMLElement;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const contentRect = { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height };
        return { target: t, contentRect } as unknown as ResizeObserverEntry;
      });
      this.callback(entries, this as unknown as ResizeObserver);
    }, 0);
  }

  unobserve(): void {}

  disconnect(): void {}
}

class StubDOMMatrixReadOnly {
  readonly m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '')?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w['ResizeObserver'] = StubResizeObserver;
  w['DOMMatrixReadOnly'] = StubDOMMatrixReadOnly;
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = StubResizeObserver;
  (globalThis as unknown as Record<string, unknown>)['DOMMatrixReadOnly'] = StubDOMMatrixReadOnly;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.width) || 1;
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.height) || 1;
      },
    },
  });
  (SVGElement.prototype as unknown as Record<string, unknown>)['getBBox'] = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
}

// The layout's types and loader live in `layout-loader.ts`, which needs no DOM.

export {
  loadLayout,
  type MapAnswer,
  type MapEdge,
  type MapLayoutModule,
  type MapNode,
  type Position,
} from './layout-loader';

// ---- People --------------------------------------------------------------------------------------

export const ORG = { id: 'org-northwind', name: 'Northwind Health' };

export interface Me {
  id: string;
  name: string;
  role: string;
  clearance: Label;
}

/** Can view assets but not edit them (D50), confidential clearance. */
export const RISK_MANAGER: Me = {
  id: 'user-dana',
  name: 'Dana Whitfield',
  role: 'risk_manager',
  clearance: 'confidential',
};

// ---- Assets and their links ----------------------------------------------------------------------

export interface StoredAsset {
  id: string;
  number: string;
  sourceIds: string[];
  name: string;
  label: Label;
  status: 'active' | 'retired';
  owner: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  origin: 'manual' | 'import' | 'ai';
  assetType: string;
  criticality: string;
  dataClassification: string;
}

export function assetId(n: number): string {
  return `00000000-0000-4000-8000-4${String(n).padStart(11, '0')}`;
}

export function assetNumber(n: number): string {
  return formatNumber('asset', 1000 + n);
}

export function makeAsset(n: number, over: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: assetId(n),
    number: assetNumber(n),
    sourceIds: [],
    name: `Asset ${String(n).padStart(3, '0')}`,
    label: 'internal',
    status: 'active',
    owner: 'user-marcus',
    version: 1,
    createdAt: '2026-03-14T09:00:00.000Z',
    createdBy: 'user-marcus',
    updatedAt: '2026-09-18T10:15:00.000Z',
    updatedBy: 'user-marcus',
    origin: 'manual',
    assetType: 'server',
    criticality: 'medium',
    dataClassification: 'internal',
    ...over,
  };
}

/**
 * The Northwind claims estate, around A1 (the claims server):
 * - step 1: A2 (A1 RUNS A2), A3 (A1 HOSTS A3), A4 (A4 HOSTS A1);
 * - step 2: A5 (A4 HOSTS A5), A7 (A7 HOSTS A3);
 * - step 3: A6 (A5 RUNS A6);
 * - A8 has no links at all.
 */
export const A = {
  claimsServer: assetId(1),
  claimsApp: assetId(2),
  claimsDb: assetId(3),
  cloudCluster: assetId(4),
  billingServer: assetId(5),
  billingApp: assetId(6),
  analyticsSwitch: assetId(7),
  laptop: assetId(8),
};

export function estate(): StoredAsset[] {
  return [
    makeAsset(1, { name: 'Claims processing server', assetType: 'server', criticality: 'critical' }),
    makeAsset(2, { name: 'Claims web app', assetType: 'application', criticality: 'high' }),
    makeAsset(3, { name: 'Claims database', assetType: 'database', criticality: 'high' }),
    makeAsset(4, { name: 'Private cloud cluster', assetType: 'cloud_service', criticality: 'critical' }),
    makeAsset(5, { name: 'Billing server', assetType: 'server', criticality: 'medium' }),
    makeAsset(6, { name: 'Billing app', assetType: 'application', criticality: 'low' }),
    makeAsset(7, { name: 'Analytics switch', assetType: 'network_device', criticality: 'medium' }),
    makeAsset(8, { name: 'Staff laptop', assetType: 'endpoint', criticality: 'low' }),
  ];
}

export function estateLinks(): MapEdge[] {
  return [
    { type: 'RUNS', fromId: A.claimsServer, toId: A.claimsApp },
    { type: 'HOSTS', fromId: A.claimsServer, toId: A.claimsDb },
    { type: 'HOSTS', fromId: A.cloudCluster, toId: A.claimsServer },
    { type: 'HOSTS', fromId: A.cloudCluster, toId: A.billingServer },
    { type: 'HOSTS', fromId: A.analyticsSwitch, toId: A.claimsDb },
    { type: 'RUNS', fromId: A.billingServer, toId: A.billingApp },
  ];
}

/** A hub that hosts `leaves` assets: more than MAP_MAX_NODES makes the map stop. */
export function hub(leaves: number): { assets: StoredAsset[]; links: MapEdge[] } {
  const assets = [
    makeAsset(1, { name: 'Shared hosting platform', assetType: 'cloud_service', criticality: 'critical' }),
  ];
  const links: MapEdge[] = [];
  for (let i = 0; i < leaves; i += 1) {
    const n = 100 + i;
    assets.push(makeAsset(n, { name: `Hosted service ${n}`, assetType: 'application' }));
    links.push({ type: 'HOSTS', fromId: assetId(1), toId: assetId(n) });
  }
  return { assets, links };
}

// ---- The fake API --------------------------------------------------------------------------------

export interface RecordedCall {
  url: URL;
  method: string;
}

export interface ErrorAnswer {
  status: number;
  code: string;
  message: string;
  referenceId: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let refCounter = 0;
function apiError(status: number, code: string, message: string, referenceId?: string): Response {
  refCounter += 1;
  return json(status, { error: { code, message, referenceId: referenceId ?? `ref-map-${refCounter}` } });
}

interface Override {
  method: string;
  path: RegExp;
  answer: ErrorAnswer;
}

export class MapApi {
  readonly calls: RecordedCall[] = [];
  readonly assets: StoredAsset[];
  readonly links: MapEdge[];
  readonly people: Person[];
  me: Me;
  private overrides: Override[] = [];

  constructor(opts: { me?: Me; assets?: StoredAsset[]; links?: MapEdge[]; people?: Person[] } = {}) {
    this.me = opts.me ?? RISK_MANAGER;
    this.assets = (opts.assets ?? estate()).map((a) => ({ ...a }));
    this.links = (opts.links ?? estateLinks()).map((l) => ({ ...l }));
    this.people = (opts.people ?? PEOPLE).map((p) => ({ ...p }));
  }

  /** Answers every matching request with this error. */
  fail(method: string, path: RegExp, answer: ErrorAnswer): void {
    this.overrides.push({ method, path, answer });
  }

  asset(id: string): StoredAsset | undefined {
    return this.assets.find((a) => a.id === id);
  }

  /** The GET /api/v1/assets/:id/map requests made so far for this asset. */
  mapCalls(id: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'GET' && c.url.pathname === `/api/v1/assets/${id}/map`);
  }

  /** The map the real API would give for this asset and depth (D204). */
  expectedMap(id: string, depth: number = MAP_DEFAULT_DEPTH): MapAnswer {
    return this.buildMap(id, depth)!;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const url = new URL(raw, window.location.href);
    this.calls.push({ url, method });
    const o = this.overrides.find((x) => x.method === method && x.path.test(url.pathname));
    if (o) return apiError(o.answer.status, o.answer.code, o.answer.message, o.answer.referenceId);
    return this.handle(method, url);
  };

  private visible(a: StoredAsset | undefined): a is StoredAsset {
    return a !== undefined && isVisible(this.me.clearance, a.label);
  }

  private node(a: StoredAsset): MapNode {
    return {
      id: a.id,
      number: a.number,
      name: a.name,
      assetType: a.assetType,
      criticality: a.criticality,
      label: a.label,
    };
  }

  private buildMap(centreId: string, depth: number): MapAnswer | null {
    const centre = this.asset(centreId);
    if (!this.visible(centre)) return null;
    const nodes: MapNode[] = [this.node(centre)];
    const seen = new Set([centre.id]);
    let frontier = [centre.id];
    let truncated = false;
    for (let step = 1; step <= depth && frontier.length > 0; step += 1) {
      const room = MAP_MAX_NODES - nodes.length;
      const found = new Map<string, StoredAsset>();
      for (const l of this.links) {
        for (const [here, there] of [
          [l.fromId, l.toId],
          [l.toId, l.fromId],
        ] as const) {
          if (!frontier.includes(here) || seen.has(there)) continue;
          const b = this.asset(there);
          if (this.visible(b)) found.set(b.id, b);
        }
      }
      const next = [...found.values()].sort((x, y) =>
        x.number === y.number ? x.id.localeCompare(y.id) : x.number.localeCompare(y.number),
      );
      if (next.length > room) {
        truncated = true;
        next.length = room;
      }
      for (const b of next) {
        nodes.push(this.node(b));
        seen.add(b.id);
      }
      frontier = next.map((b) => b.id);
      if (truncated) break;
    }
    const edges = this.links
      .filter((l) => seen.has(l.fromId) && seen.has(l.toId))
      .map((l) => ({ ...l }))
      .sort((x, y) => `${x.fromId}${x.type}${x.toId}`.localeCompare(`${y.fromId}${y.type}${y.toId}`));
    return { nodes, edges, truncated };
  }

  private handle(method: string, url: URL): Response {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/v1/me') {
      return json(200, {
        user: { id: this.me.id, email: `${this.me.id}@northwind.test`, name: this.me.name },
        org: ORG,
        role: this.me.role,
        clearance: this.me.clearance,
        mfaEnrolled: true,
      });
    }
    if (method === 'GET' && path === '/api/v1/people') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
      const sorted = [...this.people].sort((a, b) => a.name.localeCompare(b.name));
      return json(200, {
        items: sorted.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: sorted.length,
      });
    }
    const map = /^\/api\/v1\/assets\/([^/]+)\/map$/.exec(path);
    if (map && method === 'GET') {
      for (const [key] of url.searchParams) {
        if (key !== 'depth') return apiError(400, 'validation_failed', `${key}: unknown parameter.`);
      }
      const text = url.searchParams.get('depth');
      if (text !== null && !new RegExp(`^[1-${MAP_MAX_DEPTH}]$`).test(text)) {
        return apiError(400, 'validation_failed', `depth: must be a whole number from 1 to ${MAP_MAX_DEPTH}.`);
      }
      const answer = this.buildMap(map[1]!, text === null ? MAP_DEFAULT_DEPTH : Number(text));
      if (!answer) return apiError(404, 'not_found', 'The record was not found.');
      return json(200, answer);
    }
    const links = /^\/api\/v1\/assets\/([^/]+)\/links$/.exec(path);
    if (links && method === 'GET') {
      const a = this.asset(links[1]!);
      if (!this.visible(a)) return apiError(404, 'not_found', 'The record was not found.');
      const items = this.links
        .filter((l) => l.fromId === a.id || l.toId === a.id)
        .map((l) => {
          const out = l.fromId === a.id;
          return { l, out, other: this.asset(out ? l.toId : l.fromId) };
        })
        .filter((x): x is { l: MapEdge; out: boolean; other: StoredAsset } => this.visible(x.other))
        .map(({ l, out, other }) => ({
          type: l.type,
          direction: out ? 'out' : 'in',
          other: {
            id: other.id,
            kind: 'asset',
            number: other.number,
            name: other.name,
            label: other.label,
            status: other.status,
          },
          origin: 'manual',
          createdAt: '2026-04-01T09:00:00.000Z',
          createdBy: 'user-marcus',
        }));
      return json(200, { items });
    }
    const one = /^\/api\/v1\/assets\/([^/]+)$/.exec(path);
    if (one && method === 'GET') {
      const a = this.asset(one[1]!);
      if (!this.visible(a)) return apiError(404, 'not_found', 'The record was not found.');
      return json(200, a);
    }
    return apiError(404, 'not_found', 'Not found.');
  }
}

// ---- Rendering -----------------------------------------------------------------------------------

/** Installs the fake API as `fetch` and opens the app at `path` with a live session. */
export function renderApp(path: string, api = new MapApi()): { api: MapApi; user: User } {
  vi.stubGlobal('fetch', api.fetch);
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

export function resetApp(): void {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
}

export async function waitForPath(path: string): Promise<void> {
  await waitFor(() => expect(window.location.pathname).toBe(path));
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Waits for the asset page to show this asset (its number is the page title). */
export async function findAssetPage(number: string): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: number });
}

/**
 * The dependency map on the asset page: clicks its "Dependency map" tab when it has one, and
 * returns the tab panel or section that holds the map.
 */
export async function openMap(user: User): Promise<HTMLElement> {
  const place = await waitFor(
    () => {
      const tab = screen.queryByRole('tab', { name: /dependency map/i });
      if (tab) return tab;
      const region = screen.queryByRole('region', { name: /dependency map/i });
      if (region) return region;
      throw new Error('the asset page has no "Dependency map" tab or section');
    },
    { timeout: 3000 },
  );
  if (place.getAttribute('role') !== 'tab') return place;
  if (place.getAttribute('aria-selected') !== 'true') await user.click(place);
  return screen.findByRole('tabpanel', { name: /dependency map/i });
}

/** The map's node for this asset ID, once drawn. */
export async function findNode(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`);
    if (!el) throw new Error(`no map node for asset ${id}`);
    return el;
  });
}

export function queryNode(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`);
}

/** The IDs of every node on the map. */
export function nodeIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map((n) => n.dataset['id'] ?? '');
}

/** Every edge drawn on the map. */
export function edgeElements(): SVGGElement[] {
  return Array.from(document.querySelectorAll<SVGGElement>('.react-flow__edge'));
}

/** The node's position on the map, from React Flow's `translate(<x>px,<y>px)`. */
export function nodePosition(el: HTMLElement): Position {
  const m = /translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)/.exec(el.style.transform);
  expect(m, `node ${el.dataset['id']} has a translate() position`).toBeTruthy();
  return { x: Number(m![1]), y: Number(m![2]) };
}

/** Everything a node says: its text plus the aria-labels and titles inside it. */
export function nodeWords(el: HTMLElement): string {
  const extra = Array.from(el.querySelectorAll('[aria-label],[title]')).flatMap((x) => [
    x.getAttribute('aria-label') ?? '',
    x.getAttribute('title') ?? '',
  ]);
  return [el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', ...extra].join(
    ' ',
  );
}

/** Clicks a node on its number, the way a person would. */
export function clickNode(el: HTMLElement, number: string): void {
  fireEvent.click(within(el).getByText(number, { exact: false }));
}

/** The depth picker, a choice field labelled "Depth". */
export function depthPicker(inside: HTMLElement): HTMLElement {
  return within(inside).getByLabelText(/^depth/i);
}

/** The depth the picker shows. */
export function pickerValue(el: HTMLElement): string {
  if (el.tagName === 'SELECT') {
    const select = el as HTMLSelectElement;
    return (select.selectedOptions[0]?.textContent ?? select.value).trim();
  }
  return (el.textContent ?? '').trim();
}

export { MAP_DEFAULT_DEPTH, MAP_MAX_DEPTH, MAP_MAX_NODES };
