// The security matrix (D175): every record type and every API route with its access rules, in one
// table. It is the checklist for the D59 proof tests (every role cell, every org pair, every
// clearance x label combination).
//
// The security reviewer checks this table on every task (D175): a new record type or route needs
// its row here, and its D59 tests. packages/api/tests/security/security-matrix.unit.test.ts fails
// as soon as the code and this table disagree.
//
// - recordTypes: one entry per ROLE_TABLE row (D50), listed by hand so a new row must be added
//   here. `cells` is the role table row itself, not a copy. Every row is behind the org wall (D55).
//   Labels (D51, D66) apply to the record types, to uploads and the review queue (documents are
//   labelled and their findings inherit it), to chat (it sees only what the user may see) and to the
//   audit trail (D186: an entry about a record above the reader's clearance still shows that it
//   exists, but its before/after contents are hidden; the audit viewer itself is built in S7).
// - routes: one entry per API route, with its full path under /api/v1 (D30), Nest params as `:id`
//   and Fastify wildcards as `*`. `access` is 'public', 'any signed-in' or the D50 cell the route's
//   `@Requires(subject, action)` names.
import { ROLE_TABLE, type Action, type Subject } from './role-table.js';

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

export const SECURITY_MATRIX: {
  readonly recordTypes: readonly MatrixRecordType[];
  readonly routes: readonly MatrixRoute[];
} = {
  recordTypes: [
    { subject: 'asset', cells: ROLE_TABLE.asset, orgWalled: true, labels: true },
    { subject: 'risk', cells: ROLE_TABLE.risk, orgWalled: true, labels: true },
    { subject: 'control', cells: ROLE_TABLE.control, orgWalled: true, labels: true },
    { subject: 'policy', cells: ROLE_TABLE.policy, orgWalled: true, labels: true },
    { subject: 'incident', cells: ROLE_TABLE.incident, orgWalled: true, labels: true },
    { subject: 'framework_mapping', cells: ROLE_TABLE.framework_mapping, orgWalled: true, labels: true },
    { subject: 'evidence', cells: ROLE_TABLE.evidence, orgWalled: true, labels: true },
    { subject: 'audit_finding', cells: ROLE_TABLE.audit_finding, orgWalled: true, labels: true },
    { subject: 'uploads', cells: ROLE_TABLE.uploads, orgWalled: true, labels: true },
    { subject: 'review_queue', cells: ROLE_TABLE.review_queue, orgWalled: true, labels: true },
    { subject: 'audit_trail', cells: ROLE_TABLE.audit_trail, orgWalled: true, labels: true },
    { subject: 'admin', cells: ROLE_TABLE.admin, orgWalled: true, labels: false },
    { subject: 'chat', cells: ROLE_TABLE.chat, orgWalled: true, labels: true },
  ],
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
