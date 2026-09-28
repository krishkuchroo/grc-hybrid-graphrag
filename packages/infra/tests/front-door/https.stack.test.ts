// M0-016 criterion 1 (D60, D61, D65): http://grc.localhost redirects to https://grc.localhost, and
// the certificate comes from Caddy's local CA (`tls internal`).
import { lookup } from 'node:dns/promises';
import { describe, expect, it } from 'vitest';
import { HOST, ORIGIN, http, https, peerCertificate } from './helpers.js';

describe('criterion 1: one address, HTTPS only', () => {
  it(`${HOST} resolves to 127.0.0.1 (the user's hosts line, D65)`, async () => {
    const found = await lookup(HOST, { family: 4 });
    expect(found.address).toBe('127.0.0.1');
  });

  it.each(['/', '/sign-in', '/risks/RSK0001014?tab=controls', '/api/v1/health'])(
    'http://grc.localhost%s redirects permanently to the same address on https',
    async (path) => {
      const res = await http(path);
      expect([301, 308]).toContain(res.status);
      expect(res.headers.location).toBe(`${ORIGIN}${path}`);
    },
  );

  it('the plain-HTTP port serves no content of its own, only the redirect', async () => {
    const res = await http('/');
    expect(res.text).not.toContain('<div id="root">');
    expect(res.text).not.toContain('"status"');
  });

  it("the certificate for grc.localhost is trusted through Caddy's local root CA alone", async () => {
    const { authorized, error } = await peerCertificate();
    expect(error).toBeUndefined();
    expect(authorized).toBe(true);
  });

  it('the certificate names grc.localhost', async () => {
    const { cert } = await peerCertificate();
    expect(cert.subjectaltname ?? '').toMatch(/(^|,\s*)DNS:grc\.localhost(,|$)/);
  });

  it("the chain ends at Caddy's local authority, not a public CA", async () => {
    const { cert } = await peerCertificate();
    // Walk up to the self-signed root.
    let at = cert;
    for (let i = 0; i < 5 && at.issuerCertificate && at.issuerCertificate !== at; i++) {
      if (at.issuerCertificate.fingerprint256 === at.fingerprint256) break;
      at = at.issuerCertificate;
    }
    expect(String(at.subject?.CN ?? '')).toMatch(/Caddy Local Authority/);
  });

  it('https://grc.localhost answers over TLS with the trusted certificate', async () => {
    const res = await https('/');
    expect(res.status).toBe(200);
  });
});
