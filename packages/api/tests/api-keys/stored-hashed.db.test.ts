// M0-011 criterion 2 (D54: shown once, stored hashed; D57; M0-009 org-table rule).
// 2. The stored value is a hash; the plain key can't be recovered from the database.
// Also from the brief's "Interfaces": the key is shown only in the create response, and the paged
// list never shows it. The key row sits in an org table with RLS enabled and forced.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, q, seedOrg, show, type Org, type SignedIn } from '../auth/helpers.js';
import {
  KEY_PATTERN,
  admin,
  appSeesIn,
  createKey,
  everyRow,
  forbiddenForms,
  keyRow,
  listKeys,
  secretSlices,
  setUpKeys,
  tearDownKeys,
  useKey,
  type KeyEnv,
} from './helpers.js';

let env: KeyEnv | undefined;
let org: Org;
let other: Org;
let a: SignedIn;

beforeAll(async () => {
  env = await setUpKeys();
  org = await seedOrg(env.k, 'Keys Hash Org');
  other = await seedOrg(env.k, 'Keys Hash Other Org');
  a = await admin(env.k, env.app, org);
}, 180_000);

afterAll(async () => {
  await tearDownKeys(env);
});

function e(): KeyEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

describe('criterion 2: the key itself', () => {
  it('looks like grc_ followed by at least 32 URL-safe characters', async () => {
    const made = await createKey(e().app, a);
    expect(made.key).toMatch(KEY_PATTERN);
  });

  it('is different every time', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) keys.add((await createKey(e().app, a)).key);
    expect(keys.size).toBe(5);
  });

  it('works right after it is made', async () => {
    const made = await createKey(e().app, a);
    const res = await useKey(e().app, made);
    expect(res.statusCode, show(res)).toBe(200);
  });
});

describe('criterion 2: the database never holds the plain key', () => {
  it('no row in any table holds the key, its secret part, or their hex or base64 forms', async () => {
    const made = await createKey(e().app, a);
    await useKey(e().app, made); // a use must not store it either
    const all = await everyRow(e().k);
    for (const form of forbiddenForms(made.key)) {
      const hit = all.find((r) => r.text.includes(form));
      expect(hit?.table, `found a stored form of the key in ${hit?.table}`).toBeUndefined();
    }
  });

  it('no row holds any 12-character slice of the secret part', async () => {
    const made = await createKey(e().app, a);
    const all = (await everyRow(e().k)).map((r) => r.text).join('\n');
    for (const slice of secretSlices(made.key)) expect(all).not.toContain(slice);
  });

  it('the key row is in an org table with RLS enabled and forced, carrying the org', async () => {
    const made = await createKey(e().app, a);
    const { table, row } = await keyRow(e().k, made.id);
    expect(row.org_id).toBe(org.id);
    const [cls] = await q<{ on: boolean; forced: boolean }>(
      e().k,
      `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
       WHERE oid = ('public.' || quote_ident($1))::regclass`,
      [table],
    );
    expect(cls, table).toEqual({ on: true, forced: true });
  });

  it("grc_app in another org's context can't see the key row", async () => {
    const made = await createKey(e().app, a);
    const { table } = await keyRow(e().k, made.id);
    const own = await appSeesIn(e().db, table, org.id);
    expect(own.map((r) => JSON.stringify(r)).some((t) => t.includes(made.id))).toBe(true);
    const seen = await appSeesIn(e().db, table, other.id);
    expect(seen.map((r) => JSON.stringify(r)).some((t) => t.includes(made.id))).toBe(false);
  });
});

describe('criterion 2: the key is shown once', () => {
  it('the list never shows the key or any slice of it', async () => {
    const made = await createKey(e().app, a, { name: 'shown-once' });
    const res = await listKeys(e().app, a, '?pageSize=100');
    expect(res.statusCode, show(res)).toBe(200);
    for (const form of forbiddenForms(made.key)) expect(res.body).not.toContain(form);
    for (const slice of secretSlices(made.key)) expect(res.body).not.toContain(slice);
    expect(res.body).not.toMatch(/"grc_[A-Za-z0-9_-]{8,}/);
  });

  it('list items carry id, name, role and expiry, and no key or hash field', async () => {
    const made = await createKey(e().app, a, { name: 'described', role: 'analyst' });
    const res = await listKeys(e().app, a, '?pageSize=100');
    const items = (json(res).items ?? []) as Record<string, unknown>[];
    const item = items.find((i) => i.id === made.id);
    expect(item, show(res)).toBeDefined();
    expect(item).toMatchObject({ id: made.id, name: 'described', role: 'analyst' });
    expect(new Date(String(item!.expiresAt)).getTime()).toBe(new Date(made.expiresAt).getTime());
    for (const field of Object.keys(item!)) expect(field.toLowerCase()).not.toMatch(/key$|hash|secret|token/);
  });

  it('the list is paged: { items, page, pageSize, total }', async () => {
    const pagedOrg = await seedOrg(e().k, 'Keys Paging Org');
    const pa = await admin(e().k, e().app, pagedOrg);
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await createKey(e().app, pa, { name: `paged-${i}` }));
    const first = await listKeys(e().app, pa, '?page=1&pageSize=2');
    expect(first.statusCode, show(first)).toBe(200);
    const b1 = json(first) as { items: { id: string }[]; page: number; pageSize: number; total: number };
    expect(b1).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(b1.items).toHaveLength(2);
    const second = json(await listKeys(e().app, pa, '?page=2&pageSize=2')) as { items: { id: string }[] };
    expect(second.items).toHaveLength(1);
    const ids = [...b1.items, ...second.items].map((i) => i.id).sort();
    expect(ids).toEqual(made.map((m) => m.id).sort());
  });

  it('the API log never holds the key', async () => {
    const made = await createKey(e().app, a);
    await useKey(e().app, made);
    await listKeys(e().app, a);
    const text = e().logs.lines.join('\n');
    for (const form of forbiddenForms(made.key)) expect(text).not.toContain(form);
  });
});
