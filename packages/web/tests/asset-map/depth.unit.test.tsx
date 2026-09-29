// @vitest-environment jsdom
// S1-009 criterion 1, the depth picker (D204): it offers 1, 2 and 3 (MAP_MAX_DEPTH), starts at 2
// (MAP_DEFAULT_DEPTH), and asks the API again when changed, so the map shows that many steps.
// The API's own rule (S1-005): `depth` is 1 to 3, 2 when none is given.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  A,
  choose,
  depthPicker,
  findAssetPage,
  findNode,
  MAP_DEFAULT_DEPTH,
  MAP_MAX_DEPTH,
  MapApi,
  nodeIds,
  openMap,
  optionsOf,
  pickerValue,
  queryNode,
  renderApp,
  resetApp,
} from './helpers';

afterEach(resetApp);

async function open() {
  const { api, user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
  await findAssetPage(api.asset(A.claimsServer)!.number);
  const map = await openMap(user);
  await findNode(A.claimsServer);
  return { api, user, map };
}

/** The depth each map request asked for (none given means the API's default). */
function askedDepths(api: MapApi): number[] {
  return api.mapCalls(A.claimsServer).map((c) => Number(c.url.searchParams.get('depth') ?? MAP_DEFAULT_DEPTH));
}

describe('the depth picker', () => {
  it('offers exactly 1, 2 and 3', async () => {
    const { user, map } = await open();
    const options = await optionsOf(user, depthPicker(map));
    expect(options).toHaveLength(MAP_MAX_DEPTH);
    expect(options.map((o) => /^\d+/.exec(o)?.[0])).toEqual(['1', '2', '3']);
  });

  it('starts at 2, and the first map asked for is two steps out', async () => {
    const { api, map } = await open();
    expect(pickerValue(depthPicker(map))).toMatch(new RegExp(`^${MAP_DEFAULT_DEPTH}\\b`));
    expect(askedDepths(api)[0]).toBe(MAP_DEFAULT_DEPTH);
    for (const c of api.mapCalls(A.claimsServer)) {
      expect([...c.url.searchParams.keys()].every((k) => k === 'depth')).toBe(true);
    }
  });

  it('asks the API again for three steps when 3 is picked, and shows the asset three steps out', async () => {
    const { api, user, map } = await open();
    expect(queryNode(A.billingApp)).toBeNull();
    const before = api.mapCalls(A.claimsServer).length;
    await choose(user, depthPicker(map), /^3\b/);
    await waitFor(() => expect(api.mapCalls(A.claimsServer).length).toBeGreaterThan(before));
    expect(api.mapCalls(A.claimsServer).at(-1)!.url.searchParams.get('depth')).toBe('3');
    await findNode(A.billingApp);
    await waitFor(() =>
      expect(new Set(nodeIds())).toEqual(new Set(api.expectedMap(A.claimsServer, 3).nodes.map((n) => n.id))),
    );
    expect(pickerValue(depthPicker(map))).toMatch(/^3\b/);
  });

  it('asks the API again for one step when 1 is picked, and drops the assets further out', async () => {
    const { api, user, map } = await open();
    await findNode(A.billingServer);
    await choose(user, depthPicker(map), /^1\b/);
    await waitFor(() => expect(api.mapCalls(A.claimsServer).at(-1)!.url.searchParams.get('depth')).toBe('1'));
    await waitFor(() =>
      expect(new Set(nodeIds())).toEqual(new Set([A.claimsServer, A.claimsApp, A.claimsDb, A.cloudCluster])),
    );
    expect(queryNode(A.billingServer)).toBeNull();
    expect(queryNode(A.analyticsSwitch)).toBeNull();
  });

  it('goes back to two steps when 2 is picked again', async () => {
    const { api, user, map } = await open();
    await choose(user, depthPicker(map), /^1\b/);
    await waitFor(() => expect(queryNode(A.billingServer)).toBeNull());
    await choose(user, depthPicker(map), /^2\b/);
    await findNode(A.billingServer);
    await waitFor(() =>
      expect(new Set(nodeIds())).toEqual(new Set(api.expectedMap(A.claimsServer, 2).nodes.map((n) => n.id))),
    );
    expect(askedDepths(api)).toContain(1);
  });
});
