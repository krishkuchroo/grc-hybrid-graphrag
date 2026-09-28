// @vitest-environment jsdom
// S1-007 criterion 2: the create and edit forms carry each type's own fields (the S1 shared notes'
// table) with the S1-001 value lists, checked by the shared schemas before anything is sent, as
// S1-006's kit does for risks. The record page shows each type's own fields.
// The fake API checks every body with the same shared schemas, so a wrong field name, an unknown
// field or a value off the lists is refused there as well.
import { waitFor } from '@testing-library/react';
import {
  ASSET_TYPES,
  CONTROL_STATUSES,
  CRITICALITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  LABELS,
  updateSchemas,
} from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  API_PATHS,
  asValue,
  EDITORS,
  field,
  findTitle,
  mainText,
  NOUNS,
  openEditForm,
  optionsOf,
  PATHS,
  recordId,
  recordNumber,
  renderApp,
  resetApp,
  SCREEN_KINDS,
  ScreensApi,
  setDate,
  setField,
  submitButton,
  type ScreenKind,
  type User,
} from './helpers';

afterEach(resetApp);

async function openCreateForm(kind: ScreenKind, api: ScreensApi): Promise<User> {
  const { user } = renderApp(`${PATHS[kind]}/new`, api);
  await waitFor(() => field(/^name/i));
  return user;
}

/** Each kind's choice fields and the stored values they must offer. */
const CHOICES: Array<[ScreenKind, RegExp, readonly string[]]> = [
  ['control', /^control status/i, CONTROL_STATUSES],
  ['asset', /^asset type/i, ASSET_TYPES],
  ['asset', /^criticality/i, CRITICALITIES],
  ['asset', /^data classification/i, LABELS],
  ['incident', /^severity/i, INCIDENT_SEVERITIES],
  ['incident', /^incident status/i, INCIDENT_STATUSES],
];

describe("the create forms carry each type's own fields (criterion 2)", () => {
  it.each([
    ['control', [/^code/i, /^framework/i, /^control status/i, /^last tested/i]],
    ['policy', [/^policy version/i, /^effective date/i]],
    ['asset', [/^asset type/i, /^criticality/i, /^data classification/i]],
    ['incident', [/^severity/i, /^incident status/i, /^occurred/i]],
  ] as const)('%s: has name, owner, label and its own fields', async (kind, own) => {
    await openCreateForm(kind, new ScreensApi({ me: ADMIN }));
    for (const label of [/^name/i, /^owner/i, /^label/i, ...own]) expect(field(label), String(label)).toBeTruthy();
  });

  it.each(CHOICES.map(([kind, label, values]) => [kind, String(label), label, values] as const))(
    '%s: %s offers the S1-001 value list',
    async (kind, _name, label, values) => {
      const user = await openCreateForm(kind, new ScreensApi({ me: ADMIN }));
      const shown = await optionsOf(user, field(label));
      expect(shown.map(asValue)).toEqual([...values]);
    },
  );
});

describe('the create forms send what the shared schemas accept (criterion 2)', () => {
  it('controls: creates a control with its code, framework, status and last-tested day', async () => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm('control', api);
    await setField(user, /^name/i, 'Privileged access monitoring');
    await setField(user, /^code/i, 'AC-6');
    await setField(user, /^framework/i, 'NIST 800-53');
    await setField(user, /^control status/i, 'Planned');
    await setDate(user, /^last tested/i, { date: '2026-08-14' });
    await setField(user, /^owner/i, 'Priya Raman');
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(API_PATHS.control, 'POST')).toHaveLength(1));
    expect(api.callsTo(API_PATHS.control, 'POST')[0]!.body).toMatchObject({
      name: 'Privileged access monitoring',
      code: 'AC-6',
      framework: 'NIST 800-53',
      controlStatus: 'planned',
      lastTestedDate: '2026-08-14',
      owner: 'user-priya',
    });
    await waitFor(() => expect(api.records.control.some((r) => r.name === 'Privileged access monitoring')).toBe(true));
  });

  it('policies: creates a policy with its version and effective day', async () => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm('policy', api);
    await setField(user, /^name/i, 'Vendor Management Policy');
    await setField(user, /^policy version/i, '1.4');
    await setDate(user, /^effective date/i, { date: '2026-10-01' });
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(API_PATHS.policy, 'POST')).toHaveLength(1));
    expect(api.callsTo(API_PATHS.policy, 'POST')[0]!.body).toMatchObject({
      name: 'Vendor Management Policy',
      policyVersion: '1.4',
      effectiveDate: '2026-10-01',
    });
    await waitFor(() => expect(api.records.policy.some((r) => r.name === 'Vendor Management Policy')).toBe(true));
  });

  it('assets: creates an asset with its type, criticality and data classification', async () => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm('asset', api);
    await setField(user, /^name/i, 'HR payroll service');
    await setField(user, /^asset type/i, 'Cloud service');
    await setField(user, /^criticality/i, 'High');
    await setField(user, /^data classification/i, 'Restricted');
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(API_PATHS.asset, 'POST')).toHaveLength(1));
    expect(api.callsTo(API_PATHS.asset, 'POST')[0]!.body).toMatchObject({
      name: 'HR payroll service',
      assetType: 'cloud_service',
      criticality: 'high',
      dataClassification: 'restricted',
    });
    await waitFor(() => expect(api.records.asset.some((r) => r.name === 'HR payroll service')).toBe(true));
  });

  it('incidents: creates an incident with its severity, status and when it occurred', async () => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm('incident', api);
    await setField(user, /^name/i, 'Suspicious VPN logins');
    await setField(user, /^severity/i, 'Critical');
    await setField(user, /^incident status/i, 'Investigating');
    await setDate(user, /^occurred/i, { date: '2026-09-20', time: '14:30' });
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(API_PATHS.incident, 'POST')).toHaveLength(1));
    const body = api.callsTo(API_PATHS.incident, 'POST')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Suspicious VPN logins',
      severity: 'critical',
      incidentStatus: 'investigating',
    });
    const when = Date.parse(String(body.occurredAt));
    expect(Number.isNaN(when)).toBe(false);
    expect(when).toBeGreaterThanOrEqual(Date.parse('2026-09-19T00:00:00Z'));
    expect(when).toBeLessThanOrEqual(Date.parse('2026-09-22T00:00:00Z'));
    await waitFor(() => expect(api.records.incident.some((r) => r.name === 'Suspicious VPN logins')).toBe(true));
  });

  it.each([
    ['control', /^control status/i],
    ['asset', /^asset type/i],
    ['incident', /^severity/i],
  ] as const)('%s: a missing choice shows a field error and sends nothing', async (kind, missing) => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm(kind, api);
    await setField(user, /^name/i, `A new ${NOUNS[kind]}`);
    await user.click(submitButton());
    await waitFor(() => expect(field(missing).getAttribute('aria-invalid')).toBe('true'));
    expect(api.callsTo(API_PATHS[kind], 'POST')).toHaveLength(0);
  });

  it('policies: a missing effective date shows a field error and sends nothing', async () => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm('policy', api);
    await setField(user, /^name/i, 'Vendor Management Policy');
    await setField(user, /^policy version/i, '1.4');
    await user.click(submitButton());
    await waitFor(() => expect(field(/^effective date/i).getAttribute('aria-invalid')).toBe('true'));
    expect(api.callsTo(API_PATHS.policy, 'POST')).toHaveLength(0);
  });

  it.each(SCREEN_KINDS)('%s: a created record opens its own page', async (kind) => {
    const api = new ScreensApi({ me: ADMIN });
    const user = await openCreateForm(kind, api);
    await setField(user, /^name/i, `Brand new ${NOUNS[kind]}`);
    if (kind === 'control') {
      await setField(user, /^code/i, 'AC-2');
      await setField(user, /^framework/i, 'NIST 800-53');
      await setField(user, /^control status/i, 'Implemented');
      await setDate(user, /^last tested/i, { date: '2026-07-01' });
    } else if (kind === 'policy') {
      await setField(user, /^policy version/i, '1.0');
      await setDate(user, /^effective date/i, { date: '2026-07-01' });
    } else if (kind === 'asset') {
      await setField(user, /^asset type/i, 'Server');
      await setField(user, /^criticality/i, 'Low');
      await setField(user, /^data classification/i, 'Internal');
    } else {
      await setField(user, /^severity/i, 'Low');
      await setField(user, /^incident status/i, 'New');
      await setDate(user, /^occurred/i, { date: '2026-07-01', time: '09:00' });
    }
    await user.click(submitButton());
    await waitFor(() => expect(api.callsTo(API_PATHS[kind], 'POST')).toHaveLength(1));
    const created = api.records[kind].find((r) => r.name === `Brand new ${NOUNS[kind]}`);
    expect(created, 'the API created it').toBeTruthy();
    expect(await findTitle(created!.number)).toBeTruthy();
    expect(window.location.pathname).toBe(`${PATHS[kind]}/${created!.id}`);
  });
});

describe("the edit forms start from the record's own values and send only what changed (criterion 2)", () => {
  it('controls: shows the stored code, framework, status and day, and saves a status change', async () => {
    const { api, user } = renderApp(`/controls/${recordId('control', 1)}`, new ScreensApi({ me: EDITORS.control }));
    await openEditForm(user, recordNumber('control', 1));
    expect((field(/^code/i) as HTMLInputElement).value).toBe('AC-17');
    expect((field(/^framework/i) as HTMLInputElement).value).toBe('NIST 800-53');
    expect((field(/^control status/i) as HTMLSelectElement).value).toBe('implemented');
    expect((field(/^last tested/i) as HTMLInputElement).value).toBe('2026-06-30');

    await setField(user, /^control status/i, 'Planned');
    await user.click(submitButton());
    const path = `${API_PATHS.control}/${recordId('control', 1)}`;
    await waitFor(() => expect(api.callsTo(path, 'PATCH')).toHaveLength(1));
    const body = api.callsTo(path, 'PATCH')[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ controlStatus: 'planned', version: 2 });
    await waitFor(() => expect(api.record('control', recordId('control', 1))!.controlStatus).toBe('planned'));
  });

  it('policies: shows the stored version and effective day', async () => {
    const { user } = renderApp(`/policies/${recordId('policy', 1)}`, new ScreensApi({ me: EDITORS.policy }));
    await openEditForm(user, recordNumber('policy', 1));
    expect((field(/^policy version/i) as HTMLInputElement).value).toBe('3.2');
    expect((field(/^effective date/i) as HTMLInputElement).value).toBe('2026-02-01');
  });

  it('assets: shows the stored type, criticality and classification, and saves a criticality change', async () => {
    const { api, user } = renderApp(`/assets/${recordId('asset', 1)}`, new ScreensApi({ me: EDITORS.asset }));
    await openEditForm(user, recordNumber('asset', 1));
    expect((field(/^asset type/i) as HTMLSelectElement).value).toBe('server');
    expect((field(/^criticality/i) as HTMLSelectElement).value).toBe('critical');
    expect((field(/^data classification/i) as HTMLSelectElement).value).toBe('confidential');

    await setField(user, /^criticality/i, 'High');
    await user.click(submitButton());
    const path = `${API_PATHS.asset}/${recordId('asset', 1)}`;
    await waitFor(() => expect(api.callsTo(path, 'PATCH')).toHaveLength(1));
    expect(api.callsTo(path, 'PATCH')[0]!.body).toEqual({ criticality: 'high', version: 2 });
  });

  it('incidents: keeps when it occurred unless it is changed', async () => {
    const { api, user } = renderApp(`/incidents/${recordId('incident', 1)}`, new ScreensApi({ me: EDITORS.incident }));
    await openEditForm(user, recordNumber('incident', 1));
    expect((field(/^severity/i) as HTMLSelectElement).value).toBe('high');
    expect((field(/^incident status/i) as HTMLSelectElement).value).toBe('investigating');

    await setField(user, /^incident status/i, 'Contained');
    await user.click(submitButton());
    const path = `${API_PATHS.incident}/${recordId('incident', 1)}`;
    await waitFor(() => expect(api.callsTo(path, 'PATCH')).toHaveLength(1));
    const body = api.callsTo(path, 'PATCH')[0]!.body as Record<string, unknown>;
    expect(updateSchemas.incident.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ incidentStatus: 'contained', version: 2 });
    if (body.occurredAt !== undefined) {
      expect(Date.parse(String(body.occurredAt))).toBe(Date.parse('2026-09-12T08:45:00.000Z'));
    }
    await waitFor(() =>
      expect(Date.parse(String(api.record('incident', recordId('incident', 1))!.occurredAt))).toBe(
        Date.parse('2026-09-12T08:45:00.000Z'),
      ),
    );
  });
});

describe("the record page shows each type's own fields", () => {
  it.each([
    ['control', [/AC-17/, /NIST 800-53/, /implemented/i, /Jun(e)? 30,? 2026|2026-06-30|30 Jun(e)? 2026/]],
    ['policy', [/3\.2/, /Feb(ruary)? 1,? 2026|2026-02-01|1 Feb(ruary)? 2026/]],
    ['asset', [/server/i, /critical/i, /confidential/i]],
    ['incident', [/high/i, /investigating/i, /Sep(tember)? 12,? 2026|2026-09-12|12 Sep(tember)? 2026/]],
  ] as const)('%s: shows the number as title and its own field values', async (kind, values) => {
    renderApp(`${PATHS[kind]}/${recordId(kind, 1)}`, new ScreensApi({ me: ADMIN }));
    await findTitle(recordNumber(kind, 1));
    const text = mainText();
    for (const v of values) expect(text).toMatch(v);
  });
});
