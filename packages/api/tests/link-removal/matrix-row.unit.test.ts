// S1-011 criterion 10 (D175, D59): `POST /api/v1/links/remove` has one security-matrix row with the
// same access, orgWalled and labels values as the `POST /api/v1/links` row (S1-005): any signed-in
// caller, behind the org wall, with labels, because the service checks the D200 rule on both ends.
// The TEST-003 completeness test (tests/security/security-matrix.unit.test.ts) then checks that the
// code and the rows agree. This file imports the matrix only: no database, server or .env.
import { SECURITY_MATRIX } from '@grc/shared';
import { describe, expect, it } from 'vitest';

describe('criterion 10: the security-matrix row for POST /api/v1/links/remove', () => {
  it('is listed once, with the POST /api/v1/links access, orgWalled and labels', () => {
    const add = SECURITY_MATRIX.routes.filter((r) => r.method === 'POST' && r.path === '/api/v1/links');
    expect(add, 'the S1-005 row').toHaveLength(1);
    const rows = SECURITY_MATRIX.routes.filter((r) => r.method === 'POST' && r.path === '/api/v1/links/remove');
    expect(rows.length, 'security matrix row "POST /api/v1/links/remove" is missing or listed twice').toBe(1);
    expect(rows[0]).toEqual({ ...add[0], path: '/api/v1/links/remove' });
    expect(rows[0]).toEqual({
      method: 'POST',
      path: '/api/v1/links/remove',
      access: 'any signed-in',
      orgWalled: true,
      labels: true,
    });
  });
});
