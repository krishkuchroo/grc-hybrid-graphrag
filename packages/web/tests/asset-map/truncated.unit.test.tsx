// @vitest-environment jsdom
// S1-009 criterion 4: the map stops at MAP_MAX_NODES assets, the centre included (D204). When the
// API answers `truncated: true`, a notice says the map was cut short at 200 assets; with
// `truncated: false` there is no notice.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor, within } from '@testing-library/react';
import {
  A,
  findAssetPage,
  findNode,
  hub,
  MAP_MAX_NODES,
  MapApi,
  nodeIds,
  openMap,
  renderApp,
  resetApp,
} from './helpers';

afterEach(resetApp);

const CUT_SHORT = /cut short/i;

async function openHub(leaves: number) {
  const { assets, links } = hub(leaves);
  const api = new MapApi({ assets, links });
  const { user } = renderApp(`/assets/${assets[0]!.id}`, api);
  await findAssetPage(assets[0]!.number);
  const map = await openMap(user);
  const expected = api.expectedMap(assets[0]!.id);
  await findNode(expected.nodes.at(-1)!.id);
  return { api, map, expected };
}

describe('a map cut short at 200 assets', () => {
  it('says the map was cut short at 200 assets, and shows the 200 the API sent', async () => {
    const { map, expected } = await openHub(MAP_MAX_NODES + 25);
    expect(expected.truncated).toBe(true);
    expect(expected.nodes).toHaveLength(MAP_MAX_NODES);
    const notice = await within(map).findByText(CUT_SHORT);
    const said = (notice.closest('[role="status"],[role="alert"],[role="note"],p,div') ?? notice).textContent ?? '';
    expect(said).toContain(String(MAP_MAX_NODES));
    await waitFor(() => expect(nodeIds()).toHaveLength(MAP_MAX_NODES));
  });

  it('shows no notice when the map is complete, even with many assets', async () => {
    const { map, expected } = await openHub(MAP_MAX_NODES - 1);
    expect(expected.truncated).toBe(false);
    expect(expected.nodes).toHaveLength(MAP_MAX_NODES);
    await waitFor(() => expect(nodeIds()).toHaveLength(MAP_MAX_NODES));
    expect(within(map).queryByText(CUT_SHORT)).toBeNull();
    expect(map.textContent ?? '').not.toMatch(/truncated/i);
  });

  it('shows no notice on a small map', async () => {
    const { user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
    const map = await openMap(user);
    await findNode(A.claimsDb);
    expect(within(map).queryByText(CUT_SHORT)).toBeNull();
  });
});
