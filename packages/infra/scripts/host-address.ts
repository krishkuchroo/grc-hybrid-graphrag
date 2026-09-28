// The Mac-side scripts' host swap (D170). `.env` keeps one set of Postgres addresses, the
// container ones (`grc-postgres:5432`). On the Mac, Postgres is reached through the dev relay on
// 127.0.0.1:5433 (D61), so the scripts swap the host and port themselves, the way
// packages/api/tests/db/helpers.ts does (TEST_HOST, TEST_PORT).
// Pure: no I/O and no api imports, so the unit test can load it on its own.

export const HOST = '127.0.0.1';
export const PORT = '5433';

// scheme://, then an optional user[:password]@ (up to the last '@' before the path), then the
// host[:port], then the rest (path, query, fragment). Text is copied as written, so an encoded
// password stays exactly as encoded.
const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)((?:[^/?#]*@)?)([^/?#]*)(.*)$/s;

/** The same address with its host and port set to 127.0.0.1:5433; everything else unchanged. */
export function toHostAddress(url: string): string {
  const m = ADDRESS.exec(url);
  if (!m) return url;
  const [, scheme, userInfo, , rest] = m;
  return `${scheme}${userInfo}${HOST}:${PORT}${rest}`;
}
