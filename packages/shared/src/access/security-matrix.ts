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

/** A record kind's five routes (S1-004): list and get need `view`; create, update and retire
 * need `edit`. All are behind the org wall and the labels. */
function recordRoutes(subject: Subject, plural: string): MatrixRoute[] {
  const p = `/api/v1/${plural}`;
  const view = { subject, action: 'view' as const };
  const edit = { subject, action: 'edit' as const };
  return [
    { method: 'GET', path: p, access: view, orgWalled: true, labels: true },
    { method: 'GET', path: `${p}/:id`, access: view, orgWalled: true, labels: true },
    { method: 'POST', path: p, access: edit, orgWalled: true, labels: true },
    { method: 'PATCH', path: `${p}/:id`, access: edit, orgWalled: true, labels: true },
    { method: 'POST', path: `${p}/:id/retire`, access: edit, orgWalled: true, labels: true },
  ];
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
    // S1-004: the owner picker's people list, and the five routes of each record kind.
    { method: 'GET', path: '/api/v1/people', access: 'any signed-in', orgWalled: true, labels: false },
    ...recordRoutes('asset', 'assets'),
    ...recordRoutes('risk', 'risks'),
    ...recordRoutes('control', 'controls'),
    ...recordRoutes('policy', 'policies'),
    ...recordRoutes('incident', 'incidents'),
    // Links (S1-005). Adding one is open to any signed-in user because the D200 rule depends on
    // both ends; the service checks it.
    { method: 'POST', path: '/api/v1/links', access: 'any signed-in', orgWalled: true, labels: true },
    // Removing one (S1-011, D201, D207): the same rule as adding, checked by the service.
    { method: 'POST', path: '/api/v1/links/remove', access: 'any signed-in', orgWalled: true, labels: true },
    {
      method: 'GET',
      path: '/api/v1/assets/:id/links',
      access: { subject: 'asset', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/risks/:id/links',
      access: { subject: 'risk', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/controls/:id/links',
      access: { subject: 'control', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/policies/:id/links',
      access: { subject: 'policy', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/incidents/:id/links',
      access: { subject: 'incident', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/assets/:id/map',
      access: { subject: 'asset', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    // Frameworks, the read side (S2-004). Every role views framework mappings (D50); the counts and
    // the controls under a requirement hold only what the caller can see (D51). A control's
    // requirements follow the control row, with a Control Owner limited to their own controls.
    {
      method: 'GET',
      path: '/api/v1/frameworks',
      access: { subject: 'framework_mapping', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/frameworks/:id',
      access: { subject: 'framework_mapping', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/frameworks/:id/requirements',
      access: { subject: 'framework_mapping', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/requirements/:id',
      access: { subject: 'framework_mapping', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/controls/:id/requirements',
      access: { subject: 'control', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    // Framework mappings (S2-005, D212 (3)): adding and removing a control-to-requirement mapping
    // need the Framework-mappings `edit` cell (Admin and Compliance Manager); the service then
    // checks both records and `canMapControl`. An `ai` mapping is never removed here (D207).
    {
      method: 'POST',
      path: '/api/v1/mappings',
      access: { subject: 'framework_mapping', action: 'edit' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/mappings/remove',
      access: { subject: 'framework_mapping', action: 'edit' },
      orgWalled: true,
      labels: true,
    },
    // Audit findings (S3-010, D50, D213 (2), R11): the Auditor edits, Admin, Risk Manager,
    // Compliance Manager, Control Owner and Analyst view, the Viewer sees none (403 on the list,
    // 404 on every route naming a finding). CONCERNS links are added and removed with the
    // finding's `edit` cell, and the service checks both records and `canLinkFinding`; an `ai`
    // link is never removed here (D207), nor a finding's last one. The findings of a control
    // follow the control row (a Control Owner only on their own controls), those of a risk the
    // risk row; both list only findings the caller can see.
    ...recordRoutes('audit_finding', 'audit-findings'),
    {
      method: 'GET',
      path: '/api/v1/audit-findings/:id/concerns',
      access: { subject: 'audit_finding', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/audit-findings/:id/concerns',
      access: { subject: 'audit_finding', action: 'edit' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/audit-findings/:id/concerns/remove',
      access: { subject: 'audit_finding', action: 'edit' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/controls/:id/audit-findings',
      access: { subject: 'control', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/risks/:id/audit-findings',
      access: { subject: 'risk', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    // Documents (S3-005, D53, D73): the `uploads` cell at the guard (the Control Owner, Auditor
    // and Viewer get 403), then the role's view cell for the document's record type and the label,
    // checked by the service and again by RLS (404 when hidden). Evidence documents are never
    // listed or served here (S3-009). Every download is audited as `document.downloaded`.
    {
      method: 'GET',
      path: '/api/v1/documents',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/documents/:id',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/documents/:id/download',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    // Imports and saved mappings (S3-006, D44, D73): the `uploads` cell at the guard (the Control
    // Owner, Auditor and Viewer get 403). An import is also checked for the role's asset view and
    // its label by the service and again by RLS (404 when hidden); mappings are behind the org wall.
    // Saving a mapping is versioned (409 stale_version) and audited as `import_mapping.saved`.
    {
      method: 'GET',
      path: '/api/v1/imports',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/imports/:id',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/import-mappings',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/import-mappings/:id',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/import-mappings',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    // Uploads (S3-004, D53, D64): the `uploads` cell at the guard (the Control Owner, Auditor and
    // Viewer get 403), then `canUpload(role, kind)` and the label against the caller's clearance
    // (D198) in the service. The document lands only in the caller's org (row, bucket and audit
    // trail); a repeat of content the org already has stores nothing again. Audited as
    // `document.uploaded`; 20 uploads a minute per person.
    {
      method: 'POST',
      path: '/api/v1/uploads',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
  ],
};
