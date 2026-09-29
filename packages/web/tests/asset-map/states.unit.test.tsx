// @vitest-environment jsdom
// S1-009 criterion 5: an asset with no HOSTS or RUNS links shows a friendly empty state, and a failed
// map request shows the API's message and reference ID (D47), as the records kit does for its own
// errors (S1-006's ApiProblem). The rest of the asset's page stays.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { A, edgeElements, findAssetPage, findNode, MapApi, openMap, queryNode, renderApp, resetApp } from './helpers';

afterEach(resetApp);

const EMPTY = /no dependencies/i;

describe('an asset with no links', () => {
  it('shows a friendly empty state instead of a bare map', async () => {
    const api = new MapApi();
    const laptop = api.asset(A.laptop)!;
    const { user } = renderApp(`/assets/${laptop.id}`, api);
    await findAssetPage(laptop.number);
    const map = await openMap(user);
    expect(await within(map).findByText(EMPTY)).toBeTruthy();
    expect(api.mapCalls(laptop.id).length).toBeGreaterThan(0);
    expect(within(map).queryByRole('alert')).toBeNull();
    expect(edgeElements()).toHaveLength(0);
  });

  it('doesn’t show the empty state for an asset that has links', async () => {
    const { user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
    const map = await openMap(user);
    await findNode(A.claimsDb);
    expect(within(map).queryByText(EMPTY)).toBeNull();
  });
});

describe('a failed map request', () => {
  it('shows the API’s message and reference ID, and keeps the asset’s page', async () => {
    const api = new MapApi();
    api.fail('GET', /\/api\/v1\/assets\/[^/]+\/map$/, {
      status: 500,
      code: 'internal_error',
      message: 'Something went wrong on our side. Try again.',
      referenceId: 'ref-map-7f3a91',
    });
    const server = api.asset(A.claimsServer)!;
    const { user } = renderApp(`/assets/${server.id}`, api);
    await findAssetPage(server.number);
    const map = await openMap(user);
    const alert = await within(map).findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong on our side. Try again.');
    expect(alert.textContent).toContain('ref-map-7f3a91');
    // The asset's own page is still there.
    expect(screen.getByRole('heading', { level: 1, name: server.number })).toBeTruthy();
    expect(screen.getAllByText(server.name).length).toBeGreaterThan(0);
    expect(queryNode(A.claimsDb)).toBeNull();
    expect(within(map).queryByText(EMPTY)).toBeNull();
  });

  it('shows a refusal the same way, with its reference ID', async () => {
    const api = new MapApi();
    api.fail('GET', /\/api\/v1\/assets\/[^/]+\/map$/, {
      status: 403,
      code: 'forbidden',
      message: 'You do not have permission to do this.',
      referenceId: 'ref-map-0c42d8',
    });
    const { user } = renderApp(`/assets/${A.claimsServer}`, api);
    const map = await openMap(user);
    const alert = await within(map).findByRole('alert');
    expect(alert.textContent).toContain('You do not have permission to do this.');
    expect(alert.textContent).toContain('ref-map-0c42d8');
  });
});
