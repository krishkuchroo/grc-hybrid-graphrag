// @vitest-environment jsdom
// S1-008 criterion 3, the "Add link" dialog (D200, the spec's six links):
// - It offers only the link types `linkTypesBetween` allows from this record, one per direction,
//   named like the groups.
// - It searches the other end by name or number through that type's list route (`q`), and only
//   records the person can see appear.
// - Each other end offered passes `canLinkRecords` (D200): the person can edit this record or that
//   one, and sees both.
// - The link it adds goes the ontology's way: POST /api/v1/links with `{ type, fromId, toId }` and
//   `isAllowedLink(type, fromKind, toKind)` true (S1-005's route).
// criterion 4, part two: a successful add refreshes the group.
import { within } from '@testing-library/react';
import { canLinkRecords, isAllowedLink, linkTypesBetween, RECORD_KINDS, type RecordKind } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  ADMIN,
  addButton,
  ANALYST,
  C,
  CONTROL_OWNER,
  expectRow,
  findGroup,
  flush,
  I,
  linkTypeOptions,
  LinksApi,
  numbersIn,
  openAddLink,
  openRecord,
  P,
  pickLinkType,
  pickRecord,
  R,
  resetApp,
  RISK_MANAGER,
  search,
  type StoredRecord,
} from './helpers';

afterEach(resetApp);

interface Offer {
  /** The option's shown text. */
  name: RegExp;
  type: string;
  /** The other end's kind. */
  other: RecordKind;
  /** Whether this record is the link's `from` end. */
  out: boolean;
}

/** Per record kind, the links the ontology allows from it, as the dialog names them. */
const OFFERS: Record<RecordKind, Offer[]> = {
  risk: [
    { name: /^assets exposed to this risk/i, type: 'EXPOSED_TO', other: 'asset', out: false },
    { name: /^controls that treat this risk/i, type: 'MITIGATED_BY', other: 'control', out: true },
    { name: /^incidents that exposed this risk/i, type: 'EXPOSES', other: 'incident', out: false },
  ],
  control: [
    { name: /^risks it treats/i, type: 'MITIGATED_BY', other: 'risk', out: false },
    { name: /^policies that govern it/i, type: 'GOVERNED_BY', other: 'policy', out: true },
  ],
  policy: [{ name: /^controls it governs/i, type: 'GOVERNED_BY', other: 'control', out: false }],
  asset: [
    { name: /^hosts(?!.*hosted)/i, type: 'HOSTS', other: 'asset', out: true },
    { name: /^hosted by/i, type: 'HOSTS', other: 'asset', out: false },
    { name: /^runs(?! on)(?!.*runs on)/i, type: 'RUNS', other: 'asset', out: true },
    { name: /^runs on/i, type: 'RUNS', other: 'asset', out: false },
    { name: /^risks it is exposed to/i, type: 'EXPOSED_TO', other: 'risk', out: true },
    { name: /^incidents that impacted it/i, type: 'IMPACTS', other: 'incident', out: false },
  ],
  incident: [
    { name: /^assets impacted/i, type: 'IMPACTS', other: 'asset', out: true },
    { name: /^risks exposed/i, type: 'EXPOSES', other: 'risk', out: true },
  ],
};

/** A record per kind with room for a new link, and the other end to add. */
const PAGE: Record<RecordKind, StoredRecord> = {
  risk: R.vendor,
  control: C.backups,
  policy: P.access,
  asset: A.core,
  incident: I.phishing,
};

describe('the offers agree with the ontology', () => {
  it('each kind’s offers are exactly linkTypesBetween, both ways', () => {
    for (const kind of RECORD_KINDS) {
      const expected = RECORD_KINDS.flatMap((other) => [
        ...linkTypesBetween(kind, other).map((type) => `${type}:out:${other}`),
        ...linkTypesBetween(other, kind).map((type) => `${type}:in:${other}`),
      ]).sort();
      const offers = OFFERS[kind].map((o) => `${o.type}:${o.out ? 'out' : 'in'}:${o.other}`).sort();
      expect(offers, kind).toEqual(expected);
    }
  });
});

describe('the link types the dialog offers', () => {
  for (const kind of RECORD_KINDS) {
    it(`on a ${kind}: exactly the ${OFFERS[kind].length} the ontology allows`, async () => {
      const { user } = await openRecord(PAGE[kind], new LinksApi({ me: ADMIN }));
      const dialog = await openAddLink(user);
      const shown = await linkTypeOptions(user, dialog);
      expect(shown).toHaveLength(OFFERS[kind].length);
      for (const offer of OFFERS[kind]) {
        expect(
          shown.filter((text) => offer.name.test(text)),
          `one option for ${offer.type} ${offer.out ? 'out' : 'in'}`,
        ).toHaveLength(1);
      }
    });
  }

  for (const kind of RECORD_KINDS) {
    it(`on a ${kind}: each type searches its other end’s list route by name or number`, async () => {
      const api = new LinksApi({ me: ADMIN });
      const { user } = await openRecord(PAGE[kind], api);
      const dialog = await openAddLink(user);
      for (const offer of OFFERS[kind]) {
        await pickLinkType(user, dialog, offer.name);
        const text = offer.other === 'risk' ? 'RSK000' : offer.other === 'asset' ? 'claims' : 'a';
        await search(user, dialog, api, offer.other, text);
      }
    });
  }
});

/** Adds one link through the dialog and returns the POST body. */
async function addThrough(
  api: LinksApi,
  page: StoredRecord,
  offer: RegExp,
  otherKind: RecordKind,
  query: string,
  other: StoredRecord,
): Promise<{ body: unknown; dialog: HTMLElement; user: Awaited<ReturnType<typeof openRecord>>['user'] }> {
  const { user } = await openRecord(page, api);
  const dialog = await openAddLink(user);
  await pickLinkType(user, dialog, offer);
  await search(user, dialog, api, otherKind, query);
  await pickRecord(user, dialog, other.number);
  await user.click(addButton(dialog));
  await flush();
  const posts = api.postLinkCalls();
  expect(posts, 'one POST /api/v1/links').toHaveLength(1);
  return { body: posts[0]!.body, dialog, user };
}

describe('the link it adds goes the ontology’s way', () => {
  it('risk → control: MITIGATED_BY from the risk, found by name', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, R.vendor, /^controls that treat this risk/i, 'control', 'backups', C.backups);
    expect(body).toEqual({ type: 'MITIGATED_BY', fromId: R.vendor.id, toId: C.backups.id });
  });

  it('asset → risk from the risk page: EXPOSED_TO from the asset, found by number', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, R.vendor, /^assets exposed to this risk/i, 'asset', A.core.number, A.core);
    expect(body).toEqual({ type: 'EXPOSED_TO', fromId: A.core.id, toId: R.vendor.id });
    expect(isAllowedLink('EXPOSED_TO', 'asset', 'risk')).toBe(true);
  });

  it('asset "Hosts": this asset hosts the other', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, A.core, OFFERS.asset[0]!.name, 'asset', 'cluster', A.cluster);
    expect(body).toEqual({ type: 'HOSTS', fromId: A.core.id, toId: A.cluster.id });
  });

  it('asset "Hosted by": the other asset hosts this one', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, A.core, /^hosted by/i, 'asset', 'cluster', A.cluster);
    expect(body).toEqual({ type: 'HOSTS', fromId: A.cluster.id, toId: A.core.id });
  });

  it('asset "Runs on": the other asset runs this one', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, A.core, /^runs on/i, 'asset', 'cluster', A.cluster);
    expect(body).toEqual({ type: 'RUNS', fromId: A.cluster.id, toId: A.core.id });
  });

  it('policy ← control: GOVERNED_BY from the control', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { body } = await addThrough(api, P.access, /^controls it governs/i, 'control', 'backups', C.backups);
    expect(body).toEqual({ type: 'GOVERNED_BY', fromId: C.backups.id, toId: P.access.id });
  });

  it('incident → risk: EXPOSES from the incident', async () => {
    const api = new LinksApi({ me: ANALYST });
    const { body } = await addThrough(api, I.phishing, /^risks exposed/i, 'risk', 'vendor', R.vendor);
    expect(body).toEqual({ type: 'EXPOSES', fromId: I.phishing.id, toId: R.vendor.id });
  });
});

describe('a successful add refreshes the group', () => {
  it('the new control shows in "Controls that treat this risk" after the add', async () => {
    const api = new LinksApi({ me: ADMIN });
    await addThrough(api, R.vendor, /^controls that treat this risk/i, 'control', 'backups', C.backups);
    const group = await findGroup(/^controls that treat this risk$/i);
    expectRow(group, C.backups);
    expect(api.linksCalls('risk', R.vendor.id).length, 'the links asked for again').toBeGreaterThan(1);
  });
});

describe('only records the person can see, and only ends that pass canLinkRecords', () => {
  it('Risk Manager (confidential) searching controls: no restricted control appears', async () => {
    const api = new LinksApi({ me: RISK_MANAGER });
    const { user } = await openRecord(R.vendor, api);
    const dialog = await openAddLink(user);
    await pickLinkType(user, dialog, /^controls that treat this risk/i);
    await search(user, dialog, api, 'control', 'CTL');
    await within(dialog).findAllByText(new RegExp(C.backups.number));
    const shown = numbersIn(dialog);
    expect(shown).toContain(C.mfa.number);
    expect(shown).toContain(C.backups.number);
    expect(shown).not.toContain(C.vault.number);
    expect(dialog.textContent).not.toContain(C.vault.name);
  });

  it('Control Owner on a risk: only their own controls are offered', async () => {
    const api = new LinksApi({ me: CONTROL_OWNER });
    const { user } = await openRecord(R.vendor, api);
    const dialog = await openAddLink(user);
    await pickLinkType(user, dialog, /^controls that treat this risk/i);
    await search(user, dialog, api, 'control', 'CTL');
    await within(dialog).findAllByText(new RegExp(C.backups.number));
    expect(numbersIn(dialog).filter((n) => n.startsWith('CTL')).sort()).toEqual([C.mfa.number, C.backups.number].sort());
  });

  it('Risk Manager on an asset: risks are offered, but no asset (they can edit neither asset)', async () => {
    const api = new LinksApi({ me: RISK_MANAGER });
    const caller = { userId: RISK_MANAGER.id, role: RISK_MANAGER.role, clearance: RISK_MANAGER.clearance };
    expect(canLinkRecords(caller, A.core, A.cluster)).toBe(false);
    expect(canLinkRecords(caller, A.core, R.vendor)).toBe(true);

    const { user } = await openRecord(A.core, api);
    const dialog = await openAddLink(user);
    await pickLinkType(user, dialog, /^risks it is exposed to/i);
    await search(user, dialog, api, 'risk', 'vendor');
    await within(dialog).findAllByText(new RegExp(R.vendor.number));

    const shown = await linkTypeOptions(user, dialog);
    const hosts = shown.find((text) => /^hosts(?!.*hosted)/i.test(text));
    if (hosts !== undefined) {
      await pickLinkType(user, dialog, /^hosts(?!.*hosted)/i);
      await search(user, dialog, api, 'asset', 'cluster');
      expect(numbersIn(dialog).filter((n) => n.startsWith('AST'))).toEqual([]);
    }
  });

  it('Analyst on a risk: incidents are offered, but no asset (they can edit neither end)', async () => {
    const api = new LinksApi({ me: ANALYST });
    const { user } = await openRecord(R.vendor, api);
    const dialog = await openAddLink(user);
    await pickLinkType(user, dialog, /^incidents that exposed this risk/i);
    await search(user, dialog, api, 'incident', 'phishing');
    await within(dialog).findAllByText(new RegExp(I.phishing.number));

    const shown = await linkTypeOptions(user, dialog);
    if (shown.some((text) => /^assets exposed to this risk/i.test(text))) {
      await pickLinkType(user, dialog, /^assets exposed to this risk/i);
      await search(user, dialog, api, 'asset', 'claims');
      expect(numbersIn(dialog).filter((n) => n.startsWith('AST'))).toEqual([]);
    }
  });
});
