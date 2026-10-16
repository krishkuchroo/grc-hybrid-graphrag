// The Home dashboard (S8-008, D23, D27 #1, D48, D50, D51): the org's risk posture in one answer,
// counted only from what the person may see.
// - Our code picks the sections first: one per record type the role views (D45.3), from the shared
//   `dashboardSections`; a section the role can't view is left out, never sent as zeros.
// - The graph counts then run in one read transaction as the person's own role x clearance
//   read-only account, stopped after DASHBOARD_READ_TIMEOUT_MS (`readAs`), so Neo4j hides every
//   record type the role can't view, every label above the clearance and every link with a hidden
//   end. The one exception is the "own" cells (S1 shared notes): a Control Owner's controls, the
//   evidence on them and the untreated risks (which look at those controls) are counted in a
//   second read transaction as the writer, always with the owner and label conditions in the query.
// - Documents are counted in Postgres in the person's own org context, so row security checks the
//   org, the role's record types and the labels again (D73), after the same check as the
//   documents list (`GET /api/v1/documents`): the upload kinds whose record type the role views
//   (ownership cells never) and labels at or below the clearance.
// - Everything is counted in the databases; only grouped counts and the two short lists come back.
// - Log lines hold counts, times, IDs and error codes only (D163, D164).
import { and, count, eq, inArray } from 'drizzle-orm';
import type { ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import {
  CONTROL_STATUSES,
  CRITICALITIES,
  DASHBOARD_RISK_BANDS,
  DOCUMENT_RECORD_TYPE,
  DOCUMENT_STATUSES,
  FINDING_SEVERITIES,
  INCIDENT_SEVERITIES,
  OPEN_INCIDENT_STATUSES,
  RISK_SCALE,
  ROLE_TABLE,
  UPLOAD_KINDS,
  can,
  dashboardSections,
  riskRating,
  type Dashboard,
  type DashboardAssets,
  type DashboardAuditFindings,
  type DashboardControls,
  type DashboardDocuments,
  type DashboardEvidence,
  type DashboardGraphSection,
  type DashboardHeatCell,
  type DashboardIncident,
  type DashboardIncidents,
  type DashboardRisks,
  type DashboardTopRisk,
} from '@grc/shared';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { documents } from '../../intake/intake.schema.js';
import { utcToday } from '../../intake/audit-findings/finding-queries.js';
import { visibleLabels } from '../record-queries.js';
import type { Caller } from '../records.service.js';
import {
  dashboardQueries,
  type DashboardQuery,
  type DashboardQueryName,
  type DashboardScope,
} from './dashboard-queries.js';

/** Neo4j stops the dashboard's read after this long (D48: pages 95% under 300 ms). */
export const DASHBOARD_READ_TIMEOUT_MS = 5000;

type Row = Record<string, unknown>;
type Rows = Partial<Record<DashboardQueryName, Row[]>>;

export interface DashboardServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  db: Db;
  log?: Logger;
  /** The clock, for the counted time and today's date. */
  now?: () => Date;
}

/** A count as a whole number (Neo4j's integers come back as numbers; anything else is 0). */
function num(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/** A stored value as text (`''` when missing). */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** One count per value of a fixed list (every value present), from grouped rows; values outside
 * the list count only toward the total. */
function grouped<const T extends readonly string[]>(
  values: T,
  rows: readonly Row[],
): { total: number; counts: Record<T[number], number> } {
  const counts = Object.fromEntries(values.map((v) => [v, 0])) as Record<T[number], number>;
  let total = 0;
  for (const row of rows) {
    const n = num(row['n']);
    total += n;
    const value = row['value'];
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
      counts[value as T[number]] += n;
    }
  }
  return { total, counts };
}

function onScale(value: unknown): value is number {
  return typeof value === 'number' && (RISK_SCALE as readonly number[]).includes(value);
}

function risksOf(rows: Rows): DashboardRisks {
  const byBand = Object.fromEntries(DASHBOARD_RISK_BANDS.map((b) => [b, 0])) as DashboardRisks['byBand'];
  const cells = new Map<string, number>();
  let total = 0;
  for (const row of rows.riskGrid ?? []) {
    const n = num(row['n']);
    total += n;
    const impact = num(row['impact']);
    const likelihood = num(row['likelihood']);
    if (!onScale(impact) || !onScale(likelihood)) continue;
    byBand[riskRating(impact, likelihood).band] += n;
    const key = `${impact}x${likelihood}`;
    cells.set(key, (cells.get(key) ?? 0) + n);
  }
  const heatMap: DashboardHeatCell[] = [];
  for (const impact of RISK_SCALE) {
    for (const likelihood of RISK_SCALE) {
      heatMap.push({ impact, likelihood, count: cells.get(`${impact}x${likelihood}`) ?? 0 });
    }
  }
  const top: DashboardTopRisk[] = [];
  for (const row of rows.riskTop ?? []) {
    const impact = num(row['impact']);
    const likelihood = num(row['likelihood']);
    if (!onScale(impact) || !onScale(likelihood)) continue;
    const rating = riskRating(impact, likelihood);
    top.push({
      id: text(row['id']),
      number: text(row['number']),
      name: text(row['name']),
      impact,
      likelihood,
      rating: rating.score,
      band: rating.band,
    });
  }
  return { total, byBand, heatMap, untreated: num(rows.riskUntreated?.[0]?.['n']), top };
}

function controlsOf(rows: Rows): DashboardControls {
  const { total, counts } = grouped(CONTROL_STATUSES, rows.controlStatus ?? []);
  return { total, byStatus: counts, implementedShare: total === 0 ? null : counts.implemented / total };
}

function incidentsOf(rows: Rows): DashboardIncidents {
  const { total, counts } = grouped(INCIDENT_SEVERITIES, rows.incidentOpen ?? []);
  const newestOpen: DashboardIncident[] = [];
  for (const row of rows.incidentNewest ?? []) {
    const severity = row['severity'];
    const status = row['incidentStatus'];
    if (!(INCIDENT_SEVERITIES as readonly unknown[]).includes(severity)) continue;
    if (!(OPEN_INCIDENT_STATUSES as readonly unknown[]).includes(status)) continue;
    newestOpen.push({
      id: text(row['id']),
      number: text(row['number']),
      name: text(row['name']),
      severity: severity as DashboardIncident['severity'],
      incidentStatus: status as DashboardIncident['incidentStatus'],
      occurredAt: text(row['occurredAt']),
    });
  }
  return { open: total, openBySeverity: counts, newestOpen };
}

function assetsOf(rows: Rows): DashboardAssets {
  const { total, counts } = grouped(CRITICALITIES, rows.assetCriticality ?? []);
  return { total, byCriticality: counts };
}

function auditFindingsOf(rows: Rows): DashboardAuditFindings {
  const found = rows.findingOpen ?? [];
  const { total, counts } = grouped(FINDING_SEVERITIES, found);
  const overdue = found.reduce((sum, row) => sum + num(row['overdue']), 0);
  return { open: total, openBySeverity: counts, overdue };
}

function evidenceOf(rows: Rows): DashboardEvidence {
  const row = rows.evidenceValidity?.[0];
  return { expiringSoon: num(row?.['expiring']), expired: num(row?.['expired']) };
}

/** Runs each query in turn in one transaction, keeping its rows by name. */
async function runAll(tx: ManagedTransaction, queries: readonly DashboardQuery[]): Promise<Rows> {
  const rows: Rows = {};
  for (const q of queries) {
    const res = await tx.run(q.text, q.params);
    rows[q.name] = res.records.map((r) => r.toObject() as Row);
  }
  return rows;
}

export class DashboardService {
  private readonly graph: DashboardServiceDeps['graph'];
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: DashboardServiceDeps) {
    this.graph = deps.graph;
    this.db = deps.db;
    this.log = (deps.log ?? createLogger()).child({ context: 'DashboardService' });
    this.now = deps.now ?? (() => new Date());
  }

  async get(caller: Caller): Promise<Dashboard> {
    const startedAt = performance.now();
    const countedAt = this.now();
    const sections = dashboardSections(caller.role);
    const graphSections = sections.filter((s): s is DashboardGraphSection => s !== 'documents');
    const scope = this.scopeOf(caller, utcToday(countedAt));
    const queries = dashboardQueries(graphSections, scope);
    const asAccount = queries.filter((q) => !q.asWriter);
    const asWriter = queries.filter((q) => q.asWriter);

    let rows: Rows;
    let docs: DashboardDocuments | undefined;
    try {
      const [accountRows, writerRows, documentCounts] = await Promise.all([
        asAccount.length === 0
          ? Promise.resolve<Rows>({})
          : this.graph.readAs(caller.orgId, caller.role, caller.clearance, (tx) => runAll(tx, asAccount), {
              timeoutMs: DASHBOARD_READ_TIMEOUT_MS,
            }),
        asWriter.length === 0 ? Promise.resolve<Rows>({}) : this.graph.read(caller.orgId, (tx) => runAll(tx, asWriter)),
        sections.includes('documents') ? this.countDocuments(caller) : Promise.resolve(undefined),
      ]);
      rows = { ...accountRows, ...writerRows };
      docs = documentCounts;
    } catch (err) {
      this.log.error(
        { orgId: caller.orgId, elapsedMs: Math.round(performance.now() - startedAt), ...errorKind(err) },
        'dashboard count failed',
      );
      throw err;
    }

    const out: Dashboard = { countedAt: countedAt.toISOString() };
    for (const section of sections) {
      if (section === 'risks') out.risks = risksOf(rows);
      else if (section === 'controls') out.controls = controlsOf(rows);
      else if (section === 'incidents') out.incidents = incidentsOf(rows);
      else if (section === 'assets') out.assets = assetsOf(rows);
      else if (section === 'policies') out.policies = { total: num(rows.policyCount?.[0]?.['n']) };
      else if (section === 'auditFindings') out.auditFindings = auditFindingsOf(rows);
      else if (section === 'evidence') out.evidence = evidenceOf(rows);
      else if (section === 'documents' && docs !== undefined) out.documents = docs;
    }
    this.log.debug(
      {
        orgId: caller.orgId,
        sections: sections.length,
        queries: queries.length,
        writerQueries: asWriter.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      'dashboard counted',
    );
    return out;
  }

  /** What the person's graph counts may reach: their labels, and the owner conditions of the
   * role's "own" cells. */
  private scopeOf(caller: Caller, today: string): DashboardScope {
    const scope: DashboardScope = {
      clearance: caller.clearance,
      today,
      seesControls: can(caller.role, 'control', 'view', { isOwner: true }),
    };
    if (ROLE_TABLE.control[caller.role] === 'edit_own') scope.controlOwnerOnly = caller.userId;
    if (ROLE_TABLE.evidence[caller.role] === 'upload_own') scope.evidenceOwnerOnly = caller.userId;
    return scope;
  }

  /** The stored documents the person may see, per processing status: the documents list's own
   * check (upload kinds whose record type the role views, visible labels, never evidence), in the
   * person's org context so row security checks it again. */
  private async countDocuments(caller: Caller): Promise<DashboardDocuments> {
    const kinds = UPLOAD_KINDS.filter((kind) => can(caller.role, DOCUMENT_RECORD_TYPE[kind], 'view'));
    const labels = visibleLabels(caller.clearance);
    const empty = grouped(DOCUMENT_STATUSES, []);
    if (kinds.length === 0 || labels.length === 0) return { total: empty.total, byStatus: empty.counts };
    const ctx = { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
    const found = await withOrgContext(this.db, ctx, (tx) =>
      tx
        .select({ value: documents.status, n: count() })
        .from(documents)
        .where(and(eq(documents.orgId, caller.orgId), inArray(documents.kind, kinds), inArray(documents.label, labels)))
        .groupBy(documents.status),
    );
    const { total, counts } = grouped(DOCUMENT_STATUSES, found);
    return { total, byStatus: counts };
  }
}
