// @vitest-environment jsdom
// S1-006 criterion 7: a 404 on /risks/$id shows "This record doesn't exist or you can't see it",
// the same for every cause. The API already answers 404 alike for a missing record, another org's,
// a type the role can't view and a label above the clearance (S1 shared notes); the page must not
// tell them apart either, whatever the 404's own message says.
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mainText, makeRisk, RecordsApi, renderApp, resetApp, riskId, VIEWER } from './helpers';

afterEach(resetApp);

const NOT_FOUND = /This record doesn.t exist or you can.t see it/;

async function pageFor(path: string, api: RecordsApi): Promise<string> {
  renderApp(path, api);
  await screen.findByText(NOT_FOUND);
  return mainText();
}

describe('a record that is not there (criterion 7)', () => {
  it('shows the one message for a record that does not exist', async () => {
    await pageFor(`/risks/${riskId(999)}`, new RecordsApi());
    expect(screen.queryByRole('button', { name: /^edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^retire/i })).toBeNull();
  });

  it('shows the same page for a record above the clearance as for a missing one', async () => {
    const missing = await pageFor(`/risks/${riskId(999)}`, new RecordsApi({ me: VIEWER }));
    resetApp();
    const hidden = new RecordsApi({
      me: VIEWER,
      risks: [makeRisk(7, { label: 'restricted', name: 'Board-only merger risk' })],
    });
    const above = await pageFor(`/risks/${riskId(7)}`, hidden);
    expect(above).not.toContain('Board-only merger risk');
    const plain = (t: string): string =>
      t.replace(/ref-[\w-]+/g, '').replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '');
    expect(plain(above)).toBe(plain(missing));
  });

  it("does not pass on the 404's own message, so causes can't be told apart", async () => {
    const api = new RecordsApi();
    api.fail('GET', /^\/api\/v1\/risks\/[^/]+$/, {
      status: 404,
      code: 'not_found',
      message: 'Hidden by label policy',
      referenceId: 'ref-404-a',
    });
    const text = await pageFor(`/risks/${riskId(1)}`, api);
    expect(text).not.toContain('Hidden by label policy');
  });
});
