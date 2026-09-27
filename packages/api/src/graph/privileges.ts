// The Neo4j privileges of the 28 read-only query accounts (D50, D51, D57, D73), built from
// ROLE_TABLE in @grc/shared. Each account has its own role of the same name, which holds:
// - ACCESS to databases (reading only; no write, no management, nothing on DBMS).
// - MATCH on each node type the role may view (`can(role, type, 'view')`; ownership cells such
//   as `edit_own` can't be known by a shared account, so they stay hidden, fail safe), limited to
//   nodes whose `sensitivity` is at or below the clearance. A node without a matching grant is
//   invisible, and Neo4j hides every relationship with an invisible end (D51).
// - MATCH on relationships.
// - DENY TRAVERSE on the audit outbox (D73), so no other grant can ever reveal it.
import { LABELS, can, type Label, type RecordType, type Role } from '@grc/shared';
import { queryAccountName } from './query-accounts.js';

/** Neo4j node label → the D50 row that decides whether a role may view it. */
export const NODE_RECORD_TYPES: Readonly<Record<string, RecordType>> = {
  Asset: 'asset',
  Risk: 'risk',
  Control: 'control',
  Policy: 'policy',
  Incident: 'incident',
  Framework: 'framework_mapping',
  Requirement: 'framework_mapping',
  Evidence: 'evidence',
  AuditFinding: 'audit_finding',
};

export const AUDIT_OUTBOX_LABEL = 'AuditOutbox';

/** APOC procedures that reach files, URLs, other servers or outside services (D52.2). */
export const OUTSIDE_PROCEDURES = ['apoc.load.*', 'apoc.import.*', 'apoc.export.*', 'apoc.bolt.*', 'apoc.spatial.*'];

/** The labels at or below `clearance`. */
function labelsUpTo(clearance: Label): Label[] {
  return LABELS.slice(0, LABELS.indexOf(clearance) + 1);
}

/** The GRANT and DENY statements for one query account's role (run against `system`). */
export function queryAccountPrivileges(role: Role, clearance: Label): string[] {
  const name = queryAccountName(role, clearance);
  const allowed = labelsUpTo(clearance)
    .map((l) => `'${l}'`)
    .join(', ');
  const statements = [`GRANT ACCESS ON DATABASE * TO ${name}`];
  for (const [nodeLabel, recordType] of Object.entries(NODE_RECORD_TYPES)) {
    if (!can(role, recordType, 'view')) continue;
    statements.push(`GRANT MATCH {*} ON GRAPH * FOR (n:${nodeLabel}) WHERE n.sensitivity IN [${allowed}] TO ${name}`);
  }
  statements.push(`GRANT MATCH {*} ON GRAPH * RELATIONSHIPS * TO ${name}`);
  statements.push(`DENY TRAVERSE ON GRAPH * NODES ${AUDIT_OUTBOX_LABEL} TO ${name}`);
  // D52.2: a query stays inside the org's database. The built-in PUBLIC role grants LOAD and
  // EXECUTE on every procedure, so LOAD CSV and the APOC procedures that fetch, write or send
  // data outside Neo4j are denied (a DENY wins over PUBLIC's grants).
  statements.push(`DENY LOAD ON ALL DATA TO ${name}`);
  for (const procedures of OUTSIDE_PROCEDURES) {
    statements.push(`DENY EXECUTE PROCEDURE ${procedures} ON DBMS TO ${name}`);
  }
  return statements;
}
