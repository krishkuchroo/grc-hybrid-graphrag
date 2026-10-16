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
    // AI mapping suggestions (S4-009, D16 (b), D20, D212 (4)): starting a run needs the
    // Framework-mappings `edit` cell (Admin and Compliance Manager, and API keys with those roles;
    // `canSuggestMappings` in the service). The run is queued in the caller's org only, one per org,
    // kind and framework at a time, audited `mapping_suggestions.started`. The worker reads the graph
    // as the starter's role x clearance account, so no control above their clearance reaches Gemma,
    // and every pick waits as a `pending` finding labelled the higher of its two ends'; nothing is
    // written to Neo4j.
    {
      method: 'POST',
      path: '/api/v1/mappings/suggestions',
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
    // Evidence (S3-009, D50, D213 (3), R12): the Admin adds to any visible control and changes any
    // evidence; the Control Owner's `upload_own` cell passes the guard and the service lets them
    // add only to controls they own, see the evidence on their own controls (404 otherwise) and
    // change only evidence they added (403); Risk Managers, Compliance Managers, Auditors and
    // Analysts view and download (403 on create, edit and retire); the Viewer gets 403 on the
    // list and create and 404 on every route naming an item. Evidence files are stored once per
    // org by content and their document rows are read only under the intake system context, after
    // the evidence rules pass. Adding counts toward the 20 uploads a minute per person; every
    // download is audited as `document.downloaded`. The evidence on a control follows the control
    // row (a Control Owner only on their own controls) and lists only evidence the caller can see.
    ...recordRoutes('evidence', 'evidence'),
    {
      method: 'GET',
      path: '/api/v1/evidence/:id/download',
      access: { subject: 'evidence', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    // Evidence review (S3-021, D213 (2), D220 (4)): the evidence `view` cell at the guard (the
    // Viewer gets 404, the Control Owner passes with the owner rule), then in the service: API keys
    // get 403 (a review is a person's judgement, R16), hidden or missing evidence 404, and
    // `canReviewEvidence` 403 unless the caller is an Admin or a Compliance Manager who didn't add
    // it. The decision, reviewer and time are versioned (409 stale_version) and audited as
    // `record.updated` in the same transaction. Editing reviewed evidence sends it back to pending.
    {
      method: 'POST',
      path: '/api/v1/evidence/:id/review',
      access: { subject: 'evidence', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/controls/:id/evidence',
      access: { subject: 'control', action: 'view' },
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
    // Running an import (S3-007, D213 (5)): the `uploads` cell at the guard, then `canImportAssets`
    // (Admin, Risk Manager, Compliance Manager and Analyst, people and API keys) in the service; the
    // import is checked for the role's asset view and its label (404 when hidden) and RLS checks
    // again. The worker writes only in the caller's org database, refuses rows labelled above the
    // runner's clearance, and audits every change with `meta.importId`.
    {
      method: 'POST',
      path: '/api/v1/imports/:id/run',
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
    // The push API (S3-008, D47, D54, D64, D213 (5)): pushing is for API keys only (a signed-in
    // person gets 403 `api_key_required` first), then the `uploads` cell at the guard, then
    // `canImportAssets` for the key's one role in the service (Admin, Risk Manager, Compliance
    // Manager and Analyst keys push; Control Owner, Auditor and Viewer keys get 403). The org comes
    // from the key only; the batch is stored in that org's bucket and imported into its own graph,
    // labelled `internal` (never above the key's clearance), with every import entry carrying
    // `meta.importId` and `meta.pushBatchId`. A repeat batch gets the first answer. 60 batches a
    // minute per key; 1 MB. The list (people and keys) shows a batch only when its document's record
    // type is one the role views and its label is at or below the caller's clearance (checked by
    // the service and again by RLS).
    {
      method: 'POST',
      path: '/api/v1/push/batches',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/push/batches',
      access: { subject: 'uploads', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    // The Analyst review queue (S5, D24, D38, D50, D51, D52.5, D207): reading needs the Review-queue
    // `view` cell (Admin and Analyst; every other role gets 403), deciding and removing need `work`
    // (the Analyst only; an Admin gets 403), and approving a suggested mapping also needs the
    // Analyst's Framework-mappings `approve` cell (`canApproveFinding` in the service). A finding is
    // shown only at or below the reader's clearance, checked by the service and again by RLS on
    // review_findings (404 when hidden, missing or another org's); a record it names is shown only
    // if the reader's own role x clearance read finds it, else `{ hidden: true }` and it can't be
    // approved (404). Each decision locks the finding in Postgres, writes the graph change with its
    // audit entries in one Neo4j transaction as the writer, then commits the finding's status,
    // outcome and its `review.*` entry (409 `already_decided` for the loser of a race). A document
    // the reader may not see (role x record type and label) is 404; removing it (D52.5) takes every
    // AI link from it out of the graph and is audited as `document.removed`, with counts only.
    {
      method: 'GET',
      path: '/api/v1/review/findings',
      access: { subject: 'review_queue', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/review/findings/:id',
      access: { subject: 'review_queue', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/review/counts',
      access: { subject: 'review_queue', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/review/findings/:id/approve',
      access: { subject: 'review_queue', action: 'work' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/review/findings/:id/reject',
      access: { subject: 'review_queue', action: 'work' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/review/findings/:id/remove',
      access: { subject: 'review_queue', action: 'work' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/review/documents/:id',
      access: { subject: 'review_queue', action: 'view' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/review/documents/:id/remove',
      access: { subject: 'review_queue', action: 'work' },
      orgWalled: true,
      labels: true,
    },
    // Search and chat (S6, D23, D50 Chat row, D51, D52.1, D73): every role has the Chat `use` cell,
    // people and API keys alike (S6-Q8). A search or question reaches exactly what the asker could
    // open themselves: passages under Postgres row security on chunks (the org, the role's record
    // types, labels at or below the clearance), checked again in the API; graph records only through
    // the asker's own role x clearance read-only account in the org's own database, with a time
    // limit, checked again in the API; a link only if both ends are visible; never a removed
    // document's passages. Hidden things never reach Gemma or the answer. Conversations and messages
    // are their owner's only (row security on chat_conversations and chat_messages: the org and
    // app.user_id; 404 for anyone else's). A message above the reader's current clearance shows its
    // question only. Each question is audited as `chat.asked` in the transaction that saves it;
    // asking and searching share 10 a minute per person or key (D64).
    {
      method: 'POST',
      path: '/api/v1/search',
      access: { subject: 'chat', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/chat/conversations',
      access: { subject: 'chat', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/chat/conversations',
      access: { subject: 'chat', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'GET',
      path: '/api/v1/chat/conversations/:id',
      access: { subject: 'chat', action: 'use' },
      orgWalled: true,
      labels: true,
    },
    {
      method: 'POST',
      path: '/api/v1/chat/conversations/:id/messages',
      access: { subject: 'chat', action: 'use' },
      orgWalled: true,
      labels: true,
    },
  ],
};
