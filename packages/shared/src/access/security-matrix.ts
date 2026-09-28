// The security matrix (D175): every record type and every API route with its access rules, in one
// table. It is the checklist for the D59 proof tests (every role cell, every org pair, every
// clearance x label combination).
//
// The security reviewer checks this table on every task (D175): a new record type or route needs
// its row here, and its D59 tests. packages/api/tests/security/security-matrix.unit.test.ts fails
// as soon as the code and this table disagree.
//
// - recordTypes: one entry per ROLE_TABLE row (D50). `cells` is the role table row itself, not a
//   copy. Every row is behind the org wall (D55); labels apply to the record types (D51, D66).
// - routes: one entry per API route, with its full path under /api/v1 (D30), Nest params as `:id`
//   and Fastify wildcards as `*`. `access` is 'public', 'any signed-in' or the D50 cell the route's
//   `@Requires(subject, action)` names.
import { RECORD_TYPES, ROLE_TABLE, type Action, type Subject } from './role-table.js';

export type RouteAccess = 'public' | 'any signed-in' | { subject: Subject; action: Action };

export interface MatrixRecordType {
  subject: Subject;
  cells: (typeof ROLE_TABLE)[Subject];
  orgWalled: boolean;
  labels: boolean;
}

export interface MatrixRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  access: RouteAccess;
  orgWalled: boolean;
  labels: boolean;
}

const isRecordType = (subject: string): boolean => (RECORD_TYPES as readonly string[]).includes(subject);

export const SECURITY_MATRIX: {
  readonly recordTypes: readonly MatrixRecordType[];
  readonly routes: readonly MatrixRoute[];
} = {
  recordTypes: (Object.keys(ROLE_TABLE) as Subject[]).map((subject) => ({
    subject,
    cells: ROLE_TABLE[subject],
    orgWalled: true,
    labels: isRecordType(subject),
  })),
  routes: [
    { method: 'GET', path: '/api/v1/health', access: 'public', orgWalled: false, labels: false },
    { method: 'GET', path: '/api/v1/openapi.json', access: 'any signed-in', orgWalled: false, labels: false },
    { method: 'GET', path: '/api/v1/me', access: 'any signed-in', orgWalled: true, labels: false },
    {
      method: 'POST',
      path: '/api/v1/api-keys',
      access: { subject: 'admin', action: 'edit' },
      orgWalled: true,
      labels: false,
    },
    {
      method: 'GET',
      path: '/api/v1/api-keys',
      access: { subject: 'admin', action: 'edit' },
      orgWalled: true,
      labels: false,
    },
    {
      method: 'DELETE',
      path: '/api/v1/api-keys/:id',
      access: { subject: 'admin', action: 'edit' },
      orgWalled: true,
      labels: false,
    },
    { method: 'GET', path: '/api/v1/auth/*', access: 'public', orgWalled: false, labels: false },
    { method: 'POST', path: '/api/v1/auth/*', access: 'public', orgWalled: false, labels: false },
  ],
};
