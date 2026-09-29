// @vitest-environment jsdom
// S1-009 criterion 3: clicking a node on the dependency map opens that asset's page
// (`/assets/<id>`, S1-007's route), whose own map is then centred on it (D204).
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { A, clickNode, findAssetPage, findNode, MapApi, openMap, renderApp, resetApp, waitForPath } from './helpers';

afterEach(resetApp);

describe('clicking a node', () => {
  it('opens the clicked asset’s page', async () => {
    const { api, user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
    await findAssetPage(api.asset(A.claimsServer)!.number);
    await openMap(user);
    const db = api.asset(A.claimsDb)!;
    clickNode(await findNode(db.id), db.number);
    await waitForPath(`/assets/${db.id}`);
    await findAssetPage(db.number);
  });

  it('opens a page two steps out, and that page’s map is centred on it', async () => {
    const { api, user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
    await findAssetPage(api.asset(A.claimsServer)!.number);
    await openMap(user);
    const billing = api.asset(A.billingServer)!;
    clickNode(await findNode(billing.id), billing.number);
    await waitForPath(`/assets/${billing.id}`);
    await findAssetPage(billing.number);
    await openMap(user);
    await waitFor(() => expect(api.mapCalls(billing.id).length).toBeGreaterThan(0));
    // Two steps from the billing server: the cluster and its app, then the claims server.
    await findNode(A.billingApp);
    await findNode(A.claimsServer);
  });

  it('works for a node the link points away from, not only towards', async () => {
    const { api, user } = renderApp(`/assets/${A.claimsServer}`, new MapApi());
    await findAssetPage(api.asset(A.claimsServer)!.number);
    await openMap(user);
    // The cloud cluster hosts the claims server: the link runs from it to the centre.
    const cluster = api.asset(A.cloudCluster)!;
    clickNode(await findNode(cluster.id), cluster.number);
    await waitForPath(`/assets/${cluster.id}`);
    await findAssetPage(cluster.number);
  });
});
