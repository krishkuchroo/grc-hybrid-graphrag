// @vitest-environment jsdom
// S1-007 criterion 1: each list's columns and filters, on S1-006's kit.
// - Controls: number, code, name, framework, controlStatus, owner, last tested. Filters:
//   controlStatus, framework, owner.
// - Policies: number, name, policyVersion, effective date, owner.
// - Assets: number, name, assetType, criticality, data classification, owner. Filters: assetType,
//   criticality.
// - Incidents: number, name, severity, incidentStatus, occurred at. Filters: severity,
//   incidentStatus.
// Filters go to the API under its own names (D47) and live in the URL, so a reload asks the same
// question (as S1-006's register). Values are stored lowercase with `_` (D197) and shown as words.
import { screen, waitFor, within } from '@testing-library/react';
import { ASSET_TYPES, CONTROL_STATUSES, CRITICALITIES, INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  asValue,
  cellText,
  columnHeader,
  filter,
  findList,
  findTitle,
  M0_EMPTY,
  NAV_NAMES,
  optionsOf,
  PATHS,
  recordNumber,
  reload,
  renderApp,
  resetApp,
  rowNumbers,
  SCREEN_KINDS,
  ScreensApi,
  setFilter,
  waitForPath,
  type ScreenKind,
} from './helpers';

afterEach(resetApp);

const COLUMNS: Record<ScreenKind, RegExp[]> = {
  control: [/^number/i, /^code/i, /^name/i, /^framework/i, /status/i, /^owner/i, /last tested/i],
  policy: [/^number/i, /^name/i, /version/i, /effective/i, /^owner/i],
  asset: [/^number/i, /^name/i, /type/i, /criticality/i, /classification/i, /^owner/i],
  incident: [/^number/i, /^name/i, /severity/i, /status/i, /occurred/i],
};

describe('each screen opens from the navigation (criterion 1)', () => {
  it.each(SCREEN_KINDS)('%s: the nav item opens the list', async (kind) => {
    const { user } = renderApp('/', new ScreensApi({ me: ADMIN }));
    const nav = await screen.findByRole('navigation', { name: /main/i });
    await user.click(within(nav).getByRole('link', { name: NAV_NAMES[kind] }));
    await waitForPath(PATHS[kind]);
    const table = await findList();
    expect(rowNumbers(table)).toContain(recordNumber(kind, 1));
  });

  it.each(SCREEN_KINDS)("%s: the row's number opens the record page", async (kind) => {
    const { user } = renderApp(PATHS[kind], new ScreensApi({ me: ADMIN }));
    const table = await findList();
    await user.click(within(table).getByRole('link', { name: new RegExp(recordNumber(kind, 1)) }));
    expect(await findTitle(recordNumber(kind, 1))).toBeTruthy();
  });
});

describe("each list's columns (criterion 1)", () => {
  it.each(SCREEN_KINDS)('%s: shows the columns the brief names, in order', async (kind) => {
    renderApp(PATHS[kind], new ScreensApi({ me: ADMIN }));
    await findList();
    const headers = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());
    const expected = COLUMNS[kind];
    const positions = expected.map((re) => headers.findIndex((h) => re.test(h)));
    positions.forEach((p, i) => expect(p, `a column matching ${expected[i]}`).toBeGreaterThanOrEqual(0));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const re of expected) expect(columnHeader(re)).toBeTruthy();
  });

  it("controls: a row shows its code, framework, status in words, owner's name and last-tested day", async () => {
    renderApp('/controls', new ScreensApi({ me: ADMIN }));
    const table = await findList();
    const n = 'CTL0001001';
    expect(cellText(table, n, /^code/i)).toBe('AC-17');
    expect(cellText(table, n, /^name/i)).toBe('Multi-factor authentication for remote access');
    expect(cellText(table, n, /^framework/i)).toBe('NIST 800-53');
    expect(cellText(table, n, /status/i)).toMatch(/^implemented$/i);
    expect(cellText(table, 'CTL0001003', /status/i)).toMatch(/^not implemented$/i);
    expect(cellText(table, n, /^owner/i)).toBe('Priya Raman');
    // The stored day, never shifted by the time zone.
    expect(cellText(table, n, /last tested/i)).toMatch(/Jun(e)? 30,? 2026|2026-06-30|30 Jun(e)? 2026/);
  });

  it("policies: a row shows its version, effective day and owner's name", async () => {
    renderApp('/policies', new ScreensApi({ me: ADMIN }));
    const table = await findList();
    const n = 'POL0001001';
    expect(cellText(table, n, /^name/i)).toBe('Information Security Policy');
    expect(cellText(table, n, /version/i)).toContain('3.2');
    expect(cellText(table, n, /effective/i)).toMatch(/Feb(ruary)? 1,? 2026|2026-02-01|1 Feb(ruary)? 2026/);
    expect(cellText(table, n, /^owner/i)).toBe('Lena Ortiz');
  });

  it("assets: a row shows its type, criticality and classification in words, and owner's name", async () => {
    renderApp('/assets', new ScreensApi({ me: ADMIN }));
    const table = await findList();
    const n = 'AST0001001';
    expect(cellText(table, n, /^name/i)).toBe('Claims processing server');
    expect(cellText(table, n, /type/i)).toMatch(/^server$/i);
    expect(cellText(table, 'AST0001004', /type/i)).toMatch(/^network device$/i);
    expect(cellText(table, n, /criticality/i)).toMatch(/^critical$/i);
    expect(cellText(table, n, /classification/i)).toMatch(/^confidential$/i);
    expect(cellText(table, n, /^owner/i)).toBe('Omar Haddad');
  });

  it('incidents: a row shows its severity, status in words and when it occurred', async () => {
    renderApp('/incidents', new ScreensApi({ me: ADMIN }));
    const table = await findList();
    const n = 'INC0001001';
    expect(cellText(table, n, /^name/i)).toBe('Phishing email led to credential theft');
    expect(cellText(table, n, /severity/i)).toMatch(/^high$/i);
    expect(cellText(table, n, /status/i)).toMatch(/^investigating$/i);
    expect(cellText(table, n, /occurred/i)).toMatch(/Sep(tember)? 12,? 2026|2026-09-12|12 Sep(tember)? 2026/);
  });

  it.each(SCREEN_KINDS)('%s: shows only active records by default, from the API', async (kind) => {
    const { api } = renderApp(PATHS[kind], new ScreensApi({ me: ADMIN }));
    const table = await findList();
    const retired = api.records[kind].filter((r) => r.status === 'retired').map((r) => r.number);
    expect(retired.length).toBeGreaterThan(0);
    for (const n of retired) expect(rowNumbers(table)).not.toContain(n);
    expect(api.lastListCall(kind).url.searchParams.get('status') ?? 'active').toBe('active');
  });

  it.each(SCREEN_KINDS)('%s: keeps the M0 wording when there are no records', async (kind) => {
    const { api } = renderApp(PATHS[kind], new ScreensApi({ me: ADMIN, records: { [kind]: [] } }));
    await waitFor(() => expect(api.listCalls(kind).length).toBeGreaterThan(0));
    expect(await screen.findByText(M0_EMPTY[kind])).toBeTruthy();
  });
});

interface FilterCase {
  kind: ScreenKind;
  /** The filter's accessible name. */
  name: RegExp;
  /** The API's parameter. */
  param: string;
  /** The stored value list the filter offers (null: free text). */
  values: readonly string[] | null;
  /** The option to pick (by its shown text) and what to type if it's a text box. */
  pick: RegExp;
  typed: string;
  /** The value the API gets, and the rows it leaves. */
  sent: string;
  rows: string[];
}

const FILTERS: FilterCase[] = [
  {
    kind: 'control',
    name: /^control status$/i,
    param: 'controlStatus',
    values: CONTROL_STATUSES,
    pick: /^planned$/i,
    typed: 'planned',
    sent: 'planned',
    rows: ['CTL0001002'],
  },
  {
    kind: 'control',
    name: /^framework$/i,
    param: 'framework',
    values: null,
    pick: /^NIST 800-53$/,
    typed: 'NIST 800-53',
    sent: 'NIST 800-53',
    rows: ['CTL0001001', 'CTL0001003'],
  },
  {
    kind: 'asset',
    name: /^asset type$/i,
    param: 'assetType',
    values: ASSET_TYPES,
    pick: /^network device$/i,
    typed: 'network_device',
    sent: 'network_device',
    rows: ['AST0001004'],
  },
  {
    kind: 'asset',
    name: /^criticality$/i,
    param: 'criticality',
    values: CRITICALITIES,
    pick: /^high$/i,
    typed: 'high',
    sent: 'high',
    rows: ['AST0001002', 'AST0001003'],
  },
  {
    kind: 'incident',
    name: /^severity$/i,
    param: 'severity',
    values: INCIDENT_SEVERITIES,
    pick: /^critical$/i,
    typed: 'critical',
    sent: 'critical',
    rows: ['INC0001003'],
  },
  {
    kind: 'incident',
    name: /^incident status$/i,
    param: 'incidentStatus',
    values: INCIDENT_STATUSES,
    pick: /^closed$/i,
    typed: 'closed',
    sent: 'closed',
    rows: ['INC0001002'],
  },
];

describe("each list's own filters (criterion 1)", () => {
  it.each(FILTERS.filter((f) => f.values !== null).map((f) => [f.kind, f.param, f] as const))(
    '%s: the %s filter offers the S1-001 value list',
    async (_kind, _param, f) => {
      const { user } = renderApp(PATHS[f.kind], new ScreensApi({ me: ADMIN }));
      await findList();
      const shown = await optionsOf(user, filter(f.name));
      expect(shown.map(asValue)).toEqual([...f.values!]);
    },
  );

  it.each(FILTERS.map((f) => [f.kind, f.param, f] as const))(
    '%s: the %s filter asks the API and keeps the value in the URL',
    async (_kind, _param, f) => {
      const { api, user } = renderApp(PATHS[f.kind], new ScreensApi({ me: ADMIN }));
      await findList();
      await setFilter(user, f.name, f.pick, f.typed);
      await waitFor(() => expect(api.lastListCall(f.kind).url.searchParams.get(f.param)).toBe(f.sent));
      await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(f.rows));
      expect(new URLSearchParams(window.location.search).get(f.param)).toBe(f.sent);
    },
  );

  it.each(FILTERS.map((f) => [f.kind, f.param, f] as const))(
    '%s: the %s filter survives a page reload',
    async (_kind, _param, f) => {
      const { api, user } = renderApp(PATHS[f.kind], new ScreensApi({ me: ADMIN }));
      await findList();
      await setFilter(user, f.name, f.pick, f.typed);
      await waitFor(() => expect(new URLSearchParams(window.location.search).get(f.param)).toBe(f.sent));

      const before = api.calls.length;
      reload(api);
      await waitFor(() => {
        const after = api.listCalls(f.kind).filter((c) => api.calls.indexOf(c) >= before);
        expect(after.length).toBeGreaterThan(0);
        expect(after[after.length - 1]!.url.searchParams.get(f.param)).toBe(f.sent);
      });
      await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(f.rows));
    },
  );

  it('controls: the owner filter asks the API for that owner', async () => {
    const { api, user } = renderApp('/controls', new ScreensApi({ me: ADMIN }));
    await findList();
    await setFilter(user, /^owner$/i, /Priya Raman/, 'user-priya');
    await waitFor(() => expect(api.lastListCall('control').url.searchParams.get('owner')).toBe('user-priya'));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['CTL0001001', 'CTL0001003']));
    expect(new URLSearchParams(window.location.search).get('owner')).toBe('user-priya');
  });

  it("policies: sends no filter the policies list doesn't take", async () => {
    const { api } = renderApp('/policies', new ScreensApi({ me: ADMIN }));
    await findList();
    const params = [...api.lastListCall('policy').url.searchParams.keys()];
    for (const key of params) expect(['page', 'pageSize', 'sort', 'status', 'owner', 'label', 'q']).toContain(key);
  });
});
