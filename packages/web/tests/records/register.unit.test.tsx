// @vitest-environment jsdom
// S1-006 criterion 1: the Risk register's columns, rating, paging, sorting, filters and search, all
// through the API (D47), with the filters in the URL so they survive a reload.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  choose,
  columnHeader,
  dataRows,
  findRegister,
  largeRegister,
  RecordsApi,
  reload,
  renderApp,
  resetApp,
  rowNumbers,
  riskId,
} from './helpers';

afterEach(resetApp);

describe('the register columns (criterion 1)', () => {
  it('shows number, name, owner, impact, likelihood, rating, label and updated', async () => {
    renderApp('/risks');
    await findRegister();
    for (const name of [
      /^number/i,
      /^name/i,
      /^owner/i,
      /^impact/i,
      /^likelihood/i,
      /^rating/i,
      /^label/i,
      /^updated/i,
    ]) {
      expect(columnHeader(name), `a column header matching ${name}`).toBeTruthy();
    }
  });

  it("shows each row's number, name, owner name (not the ID), impact, likelihood, label and updated date", async () => {
    renderApp('/risks');
    const table = await findRegister();
    const row = dataRows(table).find((r) => r.textContent?.includes('RSK0001001'));
    expect(row, 'the row for RSK0001001').toBeTruthy();
    const text = row!.textContent ?? '';
    expect(text).toContain('Ransomware on the claims servers');
    expect(text).toContain('Dana Whitfield');
    expect(text).not.toContain('user-dana');
    expect(text).toMatch(/confidential/i);
    expect(text).toMatch(/2026/);
    const cells = within(row!)
      .getAllByRole('cell')
      .map((c) => (c.textContent ?? '').trim());
    expect(cells).toContain('5');
    expect(cells).toContain('4');
  });

  it('links each number to the record page', async () => {
    renderApp('/risks');
    const table = await findRegister();
    const link = within(table).getByRole('link', { name: /RSK0001001/ });
    expect(new URL((link as HTMLAnchorElement).href).pathname).toBe(`/risks/${riskId(1)}`);
  });

  it('shows the rating as the riskRating score and band, in a colour per band', async () => {
    renderApp('/risks');
    const table = await findRegister();
    const rows = dataRows(table);
    const critical = rows.find((r) => r.textContent?.includes('RSK0001001'))!; // 5 x 4 = 20
    const low = rows.find((r) => r.textContent?.includes('RSK0001003'))!; // 1 x 2 = 2
    const criticalBand = within(critical).getByText(/critical/i);
    const lowBand = within(low).getByText(/\blow\b/i);
    expect(critical.textContent).toContain('20');
    expect(
      within(low)
        .getAllByRole('cell')
        .some((c) => /(^|\D)2(\D|$)/.test(c.textContent ?? '')),
    ).toBe(true);
    expect(criticalBand.className, 'the bands are coloured differently').not.toBe(lowBand.className);
    expect(criticalBand.className).not.toBe('');
  });
});

describe('paging through the API (criterion 1)', () => {
  it('asks the API for the next page and shows its rows', async () => {
    const { api, user } = renderApp('/risks', new RecordsApi({ risks: largeRegister() }));
    const table = await findRegister();
    const firstPage = rowNumbers(table);
    const pageSize = Number(api.lastListCall().url.searchParams.get('pageSize') ?? '25');
    expect(firstPage.length).toBe(pageSize);

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('page')).toBe('2'));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))[0]).not.toBe(firstPage[0]));
    const second = rowNumbers(screen.getByRole('table'));
    expect(second.some((n) => firstPage.includes(n))).toBe(false);
  });

  it('shows the total the API reports', async () => {
    renderApp('/risks', new RecordsApi({ risks: largeRegister() }));
    await findRegister();
    expect(screen.getByRole('main').textContent).toMatch(/\b120\b/);
  });
});

describe('sorting through the API (criterion 1)', () => {
  it('sorts by rating when the Rating header is clicked, and flips direction on a second click', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await user.click(within(columnHeader(/^rating/i)).getByRole('button'));
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('sort')).toMatch(/^-?score$/));
    const first = api.lastListCall().url.searchParams.get('sort');

    await user.click(within(columnHeader(/^rating/i)).getByRole('button'));
    await waitFor(() => {
      const next = api.lastListCall().url.searchParams.get('sort');
      expect(next).toMatch(/^-?score$/);
      expect(next).not.toBe(first);
    });
  });

  it('shows the rows in the order the API answers', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    const header = () => within(columnHeader(/^rating/i)).getByRole('button');
    await user.click(header());
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('sort')).toMatch(/^-?score$/));
    if (api.lastListCall().url.searchParams.get('sort') !== '-score') {
      await user.click(header());
      await waitFor(() => expect(api.lastListCall().url.searchParams.get('sort')).toBe('-score'));
    }
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))[0]).toBe('RSK0001001'));
  });

  it('sorts by name when the Name header is clicked', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await user.click(within(columnHeader(/^name/i)).getByRole('button'));
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('sort')).toMatch(/^-?name$/));
  });
});

describe('filters and search through the API (criterion 1)', () => {
  it('has a search box and Band, Owner, Label and Status filters', async () => {
    renderApp('/risks');
    await findRegister();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeTruthy();
    for (const name of [/band|rating/i, /owner/i, /label/i, /status/i]) {
      expect(screen.getByRole('combobox', { name }), `a filter named ${name}`).toBeTruthy();
    }
  });

  it('asks only for active risks by default, so retired ones stay out of the list', async () => {
    const { api } = renderApp('/risks');
    const table = await findRegister();
    const status = api.lastListCall().url.searchParams.get('status');
    expect(status === null || status === 'active').toBe(true);
    expect(rowNumbers(table)).not.toContain('RSK0001005');
  });

  it('searches on the number', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await user.type(screen.getByRole('searchbox', { name: /search/i }), 'RSK0001004');
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('q')).toBe('RSK0001004'));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001004']));
  });

  it('searches on the name', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await user.type(screen.getByRole('searchbox', { name: /search/i }), 'vendor');
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('q')).toBe('vendor'));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001002']));
  });

  it('filters by band from the Band filter, and puts it in the address', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await choose(user, screen.getByRole('combobox', { name: /band|rating/i }), /^high$/i);
    await waitFor(() => expect(api.lastListCall().url.searchParams.get('band')).toBe('high'));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('band')).toBe('high'));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001004']));
  });

  it('sends every filter in the address to the API: band, owner, label, status and search', async () => {
    const { api } = renderApp('/risks?band=critical&owner=user-dana&label=confidential&status=all&q=ransom');
    await findRegister();
    const params = api.lastListCall().url.searchParams;
    expect(params.get('band')).toBe('critical');
    expect(params.get('owner')).toBe('user-dana');
    expect(params.get('label')).toBe('confidential');
    expect(params.get('status')).toBe('all');
    expect(params.get('q')).toBe('ransom');
    expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001001']);
  });

  it('shows retired risks when the status filter in the address asks for them', async () => {
    const { api } = renderApp('/risks?status=retired');
    const table = await findRegister();
    expect(api.lastListCall().url.searchParams.get('status')).toBe('retired');
    expect(rowNumbers(table)).toEqual(['RSK0001005']);
  });

  it('keeps the search after a page reload', async () => {
    const { api, user } = renderApp('/risks');
    await findRegister();
    await user.type(screen.getByRole('searchbox', { name: /search/i }), 'vendor');
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe('vendor'));

    const before = api.listCalls().length;
    reload(api);
    await waitFor(() => expect(api.listCalls().length).toBeGreaterThan(before));
    expect(api.listCalls()[before]!.url.searchParams.get('q')).toBe('vendor');
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001002']));
    expect((screen.getByRole('searchbox', { name: /search/i }) as HTMLInputElement).value).toBe('vendor');
  });

  it('keeps the owner filter after a page reload', async () => {
    const { api } = renderApp('/risks?owner=user-priya');
    await findRegister();
    const before = api.listCalls().length;
    reload(api);
    await waitFor(() => expect(api.listCalls().length).toBeGreaterThan(before));
    expect(api.listCalls()[before]!.url.searchParams.get('owner')).toBe('user-priya');
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['RSK0001002']));
  });
});
