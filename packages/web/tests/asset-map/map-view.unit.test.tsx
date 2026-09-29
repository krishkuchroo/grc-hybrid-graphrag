// @vitest-environment jsdom
// S1-009 criteria 1 and 2: the dependency map on an asset's page (screen 5, D27) shows the asset in
// the centre and its HOSTS and RUNS neighbours to the chosen depth (D204), drawn with React Flow
// (D33). Nodes show number, name and type with a mark for criticality; edges are labelled HOSTS or
// RUNS with an arrow at the end the link points to.
// The map shows exactly what the API sends: the API already leaves out hidden assets and links with
// a hidden end (D51, S1-005), so the page adds nothing and drops nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { words } from '../../src/features/records/format';
import {
  A,
  edgeElements,
  findAssetPage,
  findNode,
  loadLayout,
  MAP_DEFAULT_DEPTH,
  MapApi,
  nodeIds,
  nodePosition,
  nodeWords,
  openMap,
  renderApp,
  resetApp,
  type MapEdge,
  type MapNode,
} from './helpers';

afterEach(resetApp);

async function openClaimsServerMap() {
  const { api, user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
  await findAssetPage(api.asset(A.claimsServer)!.number);
  const map = await openMap(user);
  const expected = api.expectedMap(A.claimsServer, MAP_DEFAULT_DEPTH);
  for (const n of expected.nodes) await findNode(n.id);
  return { api, user, map, expected };
}

/** The edge drawn for this link: its aria-label names both ends, in order, by ID or number. */
function edgeFor(link: MapEdge, nodes: MapNode[]): SVGGElement[] {
  const num = (id: string) => nodes.find((n) => n.id === id)!.number;
  return edgeElements().filter((g) => {
    const label = g.getAttribute('aria-label') ?? '';
    const from = Math.max(label.indexOf(link.fromId), label.indexOf(num(link.fromId)));
    const to = Math.max(label.indexOf(link.toId), label.indexOf(num(link.toId)));
    return from >= 0 && to > from;
  });
}

describe('the map around an asset', () => {
  it('asks the API for the map of the asset whose page is open', async () => {
    const { api } = await openClaimsServerMap();
    expect(api.mapCalls(A.claimsServer).length).toBeGreaterThan(0);
    expect(
      api.calls.filter((c) => /\/map$/.test(c.url.pathname)).every((c) => c.url.pathname.includes(A.claimsServer)),
    ).toBe(true);
  });

  it('shows the asset and its HOSTS and RUNS neighbours two steps out, and nothing else', async () => {
    const { expected } = await openClaimsServerMap();
    await waitFor(() => expect(new Set(nodeIds())).toEqual(new Set(expected.nodes.map((n) => n.id))));
    // Two steps out from the claims server: the three it touches and the two beyond them.
    expect(new Set(nodeIds())).toEqual(
      new Set([A.claimsServer, A.claimsApp, A.claimsDb, A.cloudCluster, A.billingServer, A.analyticsSwitch]),
    );
    expect(nodeIds()).not.toContain(A.billingApp);
    expect(nodeIds()).not.toContain(A.laptop);
  });

  it('puts every node where the layout says, with the asset itself in the centre', async () => {
    const { expected } = await openClaimsServerMap();
    const { layoutMap } = await loadLayout();
    const positions = layoutMap(A.claimsServer, expected.nodes, expected.edges);
    for (const n of expected.nodes) {
      const el = await findNode(n.id);
      expect(nodePosition(el), `position of ${n.number}`).toEqual(positions[n.id]);
    }
  });

  it('draws each node in a box of the layout’s size, so the layout keeps them apart', async () => {
    const { expected } = await openClaimsServerMap();
    const { MAP_NODE_WIDTH, MAP_NODE_HEIGHT } = await loadLayout();
    for (const n of expected.nodes) {
      const el = await findNode(n.id);
      expect(parseFloat(el.style.width), `width of ${n.number}`).toBe(MAP_NODE_WIDTH);
      expect(parseFloat(el.style.height), `height of ${n.number}`).toBe(MAP_NODE_HEIGHT);
    }
  });
});

describe('what a node shows', () => {
  it('shows each asset’s number, name and type in words', async () => {
    const { expected } = await openClaimsServerMap();
    for (const n of expected.nodes) {
      const text = (await findNode(n.id)).textContent ?? '';
      expect(text, `node ${n.number}`).toContain(n.number);
      expect(text, `node ${n.number}`).toContain(n.name);
      expect(text.toLowerCase(), `node ${n.number}`).toContain(words(n.assetType).toLowerCase());
    }
    // `network_device` reads as words, never as the stored value.
    const switchText = (await findNode(A.analyticsSwitch)).textContent ?? '';
    expect(switchText).not.toContain('network_device');
  });

  it('marks each asset’s criticality in words', async () => {
    const { expected } = await openClaimsServerMap();
    for (const n of expected.nodes) {
      const said = nodeWords(await findNode(n.id)).toLowerCase();
      expect(said, `node ${n.number} (${n.criticality})`).toMatch(new RegExp(`\\b${n.criticality}\\b`));
    }
    // A medium asset isn't marked critical.
    const medium = nodeWords(await findNode(A.billingServer)).toLowerCase();
    expect(medium).not.toMatch(/\bcritical\b/);
  });
});

describe('what an edge shows', () => {
  it('draws one edge per link the API sends, and no others', async () => {
    const { expected } = await openClaimsServerMap();
    await waitFor(() => expect(edgeElements()).toHaveLength(expected.edges.length));
    // Two steps from the claims server: five links among its six assets.
    expect(expected.edges).toHaveLength(5);
    for (const link of expected.edges) {
      expect(edgeFor(link, expected.nodes), `edge ${link.fromId} ${link.type} ${link.toId}`).toHaveLength(1);
    }
  });

  it('labels each edge with its link type, HOSTS or RUNS', async () => {
    const { expected } = await openClaimsServerMap();
    await waitFor(() => expect(edgeElements()).toHaveLength(expected.edges.length));
    for (const link of expected.edges) {
      const [g] = edgeFor(link, expected.nodes);
      expect(g, `edge ${link.fromId} ${link.type} ${link.toId}`).toBeTruthy();
      expect((g!.textContent ?? '').trim()).toBe(link.type);
    }
    const labels = edgeElements().map((g) => (g.textContent ?? '').trim());
    expect(labels.filter((l) => l === 'HOSTS')).toHaveLength(4);
    expect(labels.filter((l) => l === 'RUNS')).toHaveLength(1);
  });

  it('puts an arrow at the end each link points to, and none at its start', async () => {
    const { expected } = await openClaimsServerMap();
    await waitFor(() => expect(edgeElements()).toHaveLength(expected.edges.length));
    for (const g of edgeElements()) {
      const path = g.querySelector('.react-flow__edge-path');
      expect(path, 'the edge has a drawn path').toBeTruthy();
      expect(path!.getAttribute('marker-end') ?? '', 'arrow at the end').toMatch(/url\(/);
      expect(path!.getAttribute('marker-start') ?? '', 'no arrow at the start').toBe('');
    }
  });
});
