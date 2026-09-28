// S1-005 criterion 6 (D175, D59, D50, D51, D55): the security-matrix rows for the 7 new routes.
// - POST /api/v1/links: 'any signed-in' (the service decides, because the D200 rule depends on
//   both ends), behind the org wall, with labels.
// - GET /api/v1/<plural>/:id/links for the five kinds: { subject: kind, action: 'view' }, org wall,
//   labels.
// - GET /api/v1/assets/:id/map: { subject: 'asset', action: 'view' }, org wall, labels.
// The TEST-003 completeness test (tests/security/security-matrix.unit.test.ts) then checks that the
// code and these rows agree. This file imports the matrix only: no database, server or .env.
import { SECURITY_MATRIX, type MatrixRoute } from '@grc/shared';
import { describe, expect, it } from 'vitest';

const KIND_PATHS = [
  ['asset', 'assets'],
  ['risk', 'risks'],
  ['control', 'controls'],
  ['policy', 'policies'],
  ['incident', 'incidents'],
] as const;

const EXPECTED: MatrixRoute[] = [
  { method: 'POST', path: '/api/v1/links', access: 'any signed-in', orgWalled: true, labels: true },
  ...KIND_PATHS.map(([subject, plural]): MatrixRoute => ({
    method: 'GET',
    path: `/api/v1/${plural}/:id/links`,
    access: { subject, action: 'view' },
    orgWalled: true,
    labels: true,
  })),
  {
    method: 'GET',
    path: '/api/v1/assets/:id/map',
    access: { subject: 'asset', action: 'view' },
    orgWalled: true,
    labels: true,
  },
];

describe('criterion 6: the security matrix lists the 7 links routes', () => {
  it('there are 7 of them', () => {
    expect(EXPECTED).toHaveLength(7);
  });

  it.each(EXPECTED.map((row) => [`${row.method} ${row.path}`, row] as const))('%s', (_name, want) => {
    const rows = SECURITY_MATRIX.routes.filter((r) => r.method === want.method && r.path === want.path);
    expect(rows.length, `security matrix row "${want.method} ${want.path}" is missing or listed twice`).toBe(1);
    expect(rows[0]).toEqual(want);
  });
});
