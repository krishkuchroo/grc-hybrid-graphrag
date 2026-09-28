// @vitest-environment jsdom
// S1-006 criterion 2: the register's empty, loading and error states. The empty state keeps the
// M0 wording (src/app/screens.ts); errors show the API's message and reference ID (D47). A role
// with no risk access isn't in D50 (every role can view risks), so it is a mocked 403.
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { findRegister, mainText, RecordsApi, renderApp, resetApp, riskId, VIEWER } from './helpers';

afterEach(resetApp);

const M0_EMPTY = 'No risks are recorded yet. Risks appear here once they are added or imported.';

describe('the register states (criterion 2)', () => {
  it('keeps the M0 wording when there are no risks', async () => {
    const { api } = renderApp('/risks', new RecordsApi({ risks: [] }));
    await waitFor(() => expect(api.listCalls().length).toBeGreaterThan(0));
    expect(await screen.findByText(M0_EMPTY)).toBeTruthy();
    expect(screen.queryAllByRole('link', { name: /RSK\d{7}/ })).toHaveLength(0);
  });

  it('shows a loading state while the API answers, then the rows', async () => {
    const api = new RecordsApi();
    const release = api.hold(/^\/api\/v1\/risks$/);
    renderApp('/risks', api);
    await waitFor(() => expect(api.listCalls().length).toBeGreaterThan(0));
    expect(await screen.findByText(/loading/i)).toBeTruthy();
    expect(screen.queryByText(M0_EMPTY)).toBeNull();

    release();
    await findRegister();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("shows the API's message and reference ID when the list fails", async () => {
    const api = new RecordsApi();
    api.fail('GET', /^\/api\/v1\/risks$/, {
      status: 500,
      code: 'internal',
      message: 'Something failed on our side. Try again.',
      referenceId: 'ref-list-500-7f3a',
    });
    renderApp('/risks', api);
    await screen.findByText(/Something failed on our side\. Try again\./);
    expect(mainText()).toContain('ref-list-500-7f3a');
    expect(screen.queryByText(M0_EMPTY)).toBeNull();
  });

  it("shows the API's 403 message and reference ID to a role with no risk access", async () => {
    const api = new RecordsApi({ me: VIEWER });
    api.fail('GET', /^\/api\/v1\/risks$/, {
      status: 403,
      code: 'forbidden',
      message: 'You do not have permission to do this.',
      referenceId: 'ref-list-403-19c2',
    });
    renderApp('/risks', api);
    await screen.findByText(/You do not have permission to do this\./);
    expect(mainText()).toContain('ref-list-403-19c2');
    expect(screen.queryByText(M0_EMPTY)).toBeNull();
    expect(screen.queryByRole('link', { name: /new risk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new risk/i })).toBeNull();
  });

  it("shows the API's message and reference ID when a record fails to load", async () => {
    const api = new RecordsApi();
    api.fail('GET', /^\/api\/v1\/risks\/[^/]+$/, {
      status: 500,
      code: 'internal',
      message: 'Something failed on our side. Try again.',
      referenceId: 'ref-get-500-a41d',
    });
    renderApp(`/risks/${riskId(1)}`, api);
    await screen.findByText(/Something failed on our side\. Try again\./);
    expect(mainText()).toContain('ref-get-500-a41d');
    expect(mainText()).not.toMatch(/doesn.t exist or you can.t see it/i);
  });
});
