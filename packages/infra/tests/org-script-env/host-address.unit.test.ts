// TEST-002 criterion 4: the host swap the Mac-side scripts use (D170).
// `.env` keeps one set of addresses, the container ones (`grc-postgres:5432`). Scripts run on the
// Mac (`seed:demo`, `org:create` and their shared loader `org-script-env.ts`) reach Postgres
// through the dev relay at 127.0.0.1:5433 (D61), so they swap the host and port themselves, the
// way packages/api/tests/db/helpers.ts does (TEST_HOST, TEST_PORT).
//
// Contract: `packages/infra/scripts/host-address.ts` exports `toHostAddress(url: string): string`.
// It is pure (no imports of the api code, no I/O). It changes only the host and port to
// 127.0.0.1:5433; the scheme, user, password (exactly as encoded), database name and query
// string stay as they were. A URL already on 127.0.0.1:5433 comes back unchanged.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(INFRA, 'scripts', 'host-address.ts');

async function toHostAddress(url: string): Promise<string> {
  if (!existsSync(MODULE)) throw new Error('packages/infra/scripts/host-address.ts does not exist yet');
  const mod = (await import(/* @vite-ignore */ MODULE)) as { toHostAddress?: (u: string) => string };
  if (typeof mod.toHostAddress !== 'function') throw new Error('host-address.ts must export toHostAddress');
  return mod.toHostAddress(url);
}

describe('toHostAddress (D170)', () => {
  it('swaps the container host for the dev relay', async () => {
    expect(await toHostAddress('postgres://grc_app:abc123@grc-postgres:5432/grc')).toBe(
      'postgres://grc_app:abc123@127.0.0.1:5433/grc',
    );
  });

  it('swaps a container host written without a port (Postgres default 5432)', async () => {
    expect(await toHostAddress('postgres://grc_app:abc123@grc-postgres/grc')).toBe(
      'postgres://grc_app:abc123@127.0.0.1:5433/grc',
    );
  });

  it('keeps a setup:secrets style password (base64url) and the migration user', async () => {
    const password = 'Zq-8_x0VbN3kLmP_qRsT-uVwXyZ012345aBcDeFgHiJ';
    expect(await toHostAddress(`postgres://grc_migrator:${password}@grc-postgres:5432/grc`)).toBe(
      `postgres://grc_migrator:${password}@127.0.0.1:5433/grc`,
    );
  });

  it('keeps a password with URL-encoded characters exactly as encoded', async () => {
    const encoded = 'p%40ss%2Fw%3Ard%25x%23y%3F';
    expect(await toHostAddress(`postgres://grc_app:${encoded}@grc-postgres:5432/grc`)).toBe(
      `postgres://grc_app:${encoded}@127.0.0.1:5433/grc`,
    );
  });

  it('keeps the database name and the query string', async () => {
    expect(
      await toHostAddress(
        'postgres://grc_app:abc@grc-postgres:5432/test-4f2a9c?sslmode=disable&application_name=grc-api',
      ),
    ).toBe('postgres://grc_app:abc@127.0.0.1:5433/test-4f2a9c?sslmode=disable&application_name=grc-api');
  });

  it('keeps the postgresql:// scheme', async () => {
    expect(await toHostAddress('postgresql://grc_app:abc@grc-postgres:5432/grc')).toBe(
      'postgresql://grc_app:abc@127.0.0.1:5433/grc',
    );
  });

  it.each([
    'postgres://grc_app:abc123@127.0.0.1:5433/grc',
    'postgres://grc_app:p%40ss%2Fw%3Ard@127.0.0.1:5433/grc?sslmode=disable',
    'postgresql://grc_migrator:Zq-8_x0V@127.0.0.1:5433/test-abc', // secret-scan: allow (a made-up test password)
  ])('leaves an address already on 127.0.0.1:5433 unchanged: %s', async (url) => {
    expect(await toHostAddress(url)).toBe(url);
  });

  it('is idempotent', async () => {
    const once = await toHostAddress('postgres://grc_app:p%40ss@grc-postgres:5432/grc?x=1');
    expect(await toHostAddress(once)).toBe(once);
  });
});
