// M0-016: the Caddyfile itself (D60, D65). A light static check that the file exists where the
// brief puts it and names the pieces the live tests then prove: the grc.localhost site, Caddy's
// local CA (`tls internal`) and the /api/v1 hand-off to grc-api. Behaviour is proved live in the
// other front-door tests.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers.js';

const CADDYFILE = join(ROOT, 'packages', 'infra', 'caddy', 'Caddyfile');

function caddyfile(): string {
  if (!existsSync(CADDYFILE)) throw new Error(`missing ${CADDYFILE}`);
  // Comments don't count.
  return readFileSync(CADDYFILE, 'utf8')
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

describe('the Caddyfile (packages/infra/caddy/Caddyfile)', () => {
  it('exists', () => {
    expect(existsSync(CADDYFILE)).toBe(true);
  });

  it('serves the grc.localhost site', () => {
    expect(caddyfile()).toMatch(/(^|\s|,|\/\/)grc\.localhost(:443)?\s*(,|\{)/m);
  });

  it("takes its certificate from Caddy's local CA (tls internal)", () => {
    // `tls internal` on the site, `issuer internal` in a tls block, or the global `local_certs`.
    expect(caddyfile()).toMatch(/^\s*(tls\s+internal|issuer\s+internal|local_certs)\b/m);
  });

  it('forwards to grc-api', () => {
    // `reverse_proxy grc-api:3000`, or a reverse_proxy block with `to grc-api:3000`.
    expect(caddyfile()).toMatch(/reverse_proxy[^{}\n]*(\{[^}]*)?\bgrc-api(:\d+)?\b/);
  });
});
