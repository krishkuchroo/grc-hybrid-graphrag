// The Home dashboard's Cypher (S8-008): one small counting query per part of a section, each
// grouped and counted in Neo4j (never by fetching every record). Every name put into the Cypher
// text comes from the fixed lists below; every value goes in as a parameter.
// - Every query counts only active records whose label is at or below the person's clearance
//   (D51), written into the query even when Neo4j's read-only account checks it again.
// - The "own" cells (S1 shared notes): a Control Owner sees only the controls they own, and only
//   the evidence that supports one of them (D213 (3)). No shared account can know who owns what,
//   so the queries reaching those controls or that evidence say `asWriter` and carry the owner
//   condition; every other query runs as the person's role x clearance account.
// - Overdue findings and expiring evidence use the lists' own conditions (`dueWhere`,
//   `validityWhere`), so the dashboard's counts match the filtered lists.
import neo4j from 'neo4j-driver';
import {
  DASHBOARD_NEWEST_INCIDENTS,
  DASHBOARD_TOP_RISKS,
  INCIDENT_SEVERITIES,
  INTAKE_NODE_LABELS,
  NODE_LABELS,
  OPEN_FINDING_STATUSES,
  OPEN_INCIDENT_STATUSES,
  RISK_SCALE,
  type DashboardGraphSection,
  type Label,
} from '@grc/shared';
import { dueWhere } from '../../intake/audit-findings/finding-queries.js';
import { SUPPORTS, validityWhere } from '../../intake/evidence/evidence-queries.js';
import { visibleLabels } from '../record-queries.js';

/** Who is counting, as the queries need it. */
export interface DashboardScope {
  clearance: Label;
  /** Today in UTC (`YYYY-MM-DD`), for overdue findings and expiring evidence. */
  today: string;
  /** Whether the role views controls at all; untreated risks look only at controls it can see. */
  seesControls: boolean;
  /** Set when the role's Control cell is `edit_own`: only this person's controls. */
  controlOwnerOnly?: string;
  /** Set when the role's Evidence cell is `upload_own`: only evidence supporting a control this
   * person owns. */
  evidenceOwnerOnly?: string;
}

export const DASHBOARD_QUERY_NAMES = [
  'riskGrid',
  'riskUntreated',
  'riskTop',
  'controlStatus',
  'incidentOpen',
  'incidentNewest',
  'assetCriticality',
  'policyCount',
  'findingOpen',
  'evidenceValidity',
] as const;
export type DashboardQueryName = (typeof DASHBOARD_QUERY_NAMES)[number];

export interface DashboardQuery {
  name: DashboardQueryName;
  text: string;
  params: Record<string, unknown>;
  /** Runs as the writer with the owner conditions in the query, for an "own" cell. */
  asWriter: boolean;
}

/** The queries each section needs. */
export const SECTION_QUERIES: Readonly<Record<DashboardGraphSection, readonly DashboardQueryName[]>> = {
  risks: ['riskGrid', 'riskUntreated', 'riskTop'],
  controls: ['controlStatus'],
  incidents: ['incidentOpen', 'incidentNewest'],
  assets: ['assetCriticality'],
  policies: ['policyCount'],
  auditFindings: ['findingOpen'],
  evidence: ['evidenceValidity'],
};

const RISK = NODE_LABELS.risk;
const CONTROL = NODE_LABELS.control;
const INCIDENT = NODE_LABELS.incident;
const ASSET = NODE_LABELS.asset;
const POLICY = NODE_LABELS.policy;
const FINDING = INTAKE_NODE_LABELS.audit_finding;
const EVIDENCE = INTAKE_NODE_LABELS.evidence;

/** An ISO date-time Neo4j's `datetime()` reads; anything else sorts last instead of failing. */
const ISO_DATE_TIME =
  '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d{1,9})?)?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$';

/** Active and at a visible label. */
function live(v: string): string {
  return `${v}.status = 'active' AND ${v}.sensitivity IN $visible`;
}

/** The controls the person can see, as a condition on `v`. */
function controlWhere(v: string, scope: DashboardScope): string {
  if (!scope.seesControls) return 'false';
  const own = scope.controlOwnerOnly !== undefined ? ` AND ${v}.owner = $controlSelf` : '';
  return `${live(v)}${own}`;
}

function baseParams(scope: DashboardScope): Record<string, unknown> {
  const params: Record<string, unknown> = { visible: visibleLabels(scope.clearance) };
  if (scope.controlOwnerOnly !== undefined) params['controlSelf'] = scope.controlOwnerOnly;
  if (scope.evidenceOwnerOnly !== undefined) params['evidenceSelf'] = scope.evidenceOwnerOnly;
  return params;
}

const ints = (values: readonly number[]) => values.map((v) => neo4j.int(v));

function build(name: DashboardQueryName, scope: DashboardScope): DashboardQuery {
  const params = baseParams(scope);
  const ownControls = scope.controlOwnerOnly !== undefined;
  switch (name) {
    case 'riskGrid':
      return {
        name,
        text: `MATCH (r:${RISK}) WHERE ${live('r')}
     RETURN r.impact AS impact, r.likelihood AS likelihood, count(r) AS n`,
        params,
        asWriter: false,
      };
    case 'riskUntreated':
      return {
        name,
        text: `MATCH (r:${RISK}) WHERE ${live('r')}
       AND NOT EXISTS { MATCH (r)-[:MITIGATED_BY]->(c:${CONTROL}) WHERE ${controlWhere('c', scope)} }
     RETURN count(r) AS n`,
        params,
        asWriter: ownControls,
      };
    case 'riskTop':
      params['scale'] = ints(RISK_SCALE);
      params['limit'] = neo4j.int(DASHBOARD_TOP_RISKS);
      return {
        name,
        text: `MATCH (r:${RISK}) WHERE ${live('r')} AND r.impact IN $scale AND r.likelihood IN $scale
     RETURN r.id AS id, r.number AS number, r.name AS name, r.impact AS impact, r.likelihood AS likelihood
     ORDER BY r.impact * r.likelihood DESC, coalesce(r.financialExposure, 0) DESC, r.number ASC
     LIMIT $limit`,
        params,
        asWriter: false,
      };
    case 'controlStatus':
      return {
        name,
        text: `MATCH (c:${CONTROL}) WHERE ${controlWhere('c', scope)}
     RETURN c.controlStatus AS value, count(c) AS n`,
        params,
        asWriter: ownControls,
      };
    case 'incidentOpen':
      params['openIncident'] = [...OPEN_INCIDENT_STATUSES];
      return {
        name,
        text: `MATCH (i:${INCIDENT}) WHERE ${live('i')} AND i.incidentStatus IN $openIncident
     RETURN i.severity AS value, count(i) AS n`,
        params,
        asWriter: false,
      };
    case 'incidentNewest':
      params['openIncident'] = [...OPEN_INCIDENT_STATUSES];
      params['severities'] = [...INCIDENT_SEVERITIES];
      params['isoDateTime'] = ISO_DATE_TIME;
      params['limit'] = neo4j.int(DASHBOARD_NEWEST_INCIDENTS);
      return {
        name,
        text: `MATCH (i:${INCIDENT}) WHERE ${live('i')} AND i.incidentStatus IN $openIncident
       AND i.severity IN $severities
     WITH i, CASE WHEN i.occurredAt =~ $isoDateTime THEN datetime(i.occurredAt) END AS at
     RETURN i.id AS id, i.number AS number, i.name AS name, i.severity AS severity,
       i.incidentStatus AS incidentStatus, i.occurredAt AS occurredAt
     ORDER BY at IS NULL, at DESC, i.number DESC
     LIMIT $limit`,
        params,
        asWriter: false,
      };
    case 'assetCriticality':
      return {
        name,
        text: `MATCH (a:${ASSET}) WHERE ${live('a')}
     RETURN a.criticality AS value, count(a) AS n`,
        params,
        asWriter: false,
      };
    case 'policyCount':
      return {
        name,
        text: `MATCH (p:${POLICY}) WHERE ${live('p')} RETURN count(p) AS n`,
        params,
        asWriter: false,
      };
    case 'findingOpen': {
      const overdue = dueWhere('overdue', scope.today, params);
      params['openFinding'] = [...OPEN_FINDING_STATUSES];
      return {
        name,
        text: `MATCH (f:${FINDING}) WHERE ${live('f')} AND f.findingStatus IN $openFinding
     RETURN f.severity AS value, count(f) AS n, sum(CASE WHEN ${overdue} THEN 1 ELSE 0 END) AS overdue`,
        params,
        asWriter: false,
      };
    }
    case 'evidenceValidity': {
      const expiring = validityWhere('expiring', scope.today, params);
      const expired = validityWhere('expired', scope.today, params);
      const own =
        scope.evidenceOwnerOnly !== undefined
          ? ` AND EXISTS { MATCH (e)-[:${SUPPORTS}]->(oc:${CONTROL}) WHERE oc.sensitivity IN $visible AND oc.owner = $evidenceSelf }`
          : '';
      return {
        name,
        text: `MATCH (e:${EVIDENCE}) WHERE ${live('e')}${own}
     RETURN sum(CASE WHEN ${expiring} THEN 1 ELSE 0 END) AS expiring,
       sum(CASE WHEN ${expired} THEN 1 ELSE 0 END) AS expired`,
        params,
        asWriter: scope.evidenceOwnerOnly !== undefined,
      };
    }
  }
}

/** The queries for the given sections, in a fixed order. */
export function dashboardQueries(sections: readonly DashboardGraphSection[], scope: DashboardScope): DashboardQuery[] {
  const names = new Set(sections.flatMap((section) => SECTION_QUERIES[section]));
  return DASHBOARD_QUERY_NAMES.filter((name) => names.has(name)).map((name) => build(name, scope));
}
