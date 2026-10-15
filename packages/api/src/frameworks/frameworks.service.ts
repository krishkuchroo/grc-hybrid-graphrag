// The frameworks read service (S2-004): the frameworks with their coverage, one framework's
// requirements (paged, filtered, searched), one requirement with the controls that satisfy it and
// its links to other frameworks, and the requirements one control satisfies.
// - Our code limits every catalog node to the caller's clearance and every control to their role's
//   cell on controls (for a Control Owner, their own) and clearance (D50, D51). The read runs as the
//   caller's read-only role x clearance account (readAs, with a time limit), so Neo4j checks again
//   and hides every link with a hidden end (D45.3, D59). Only a Control Owner's reads run as the
//   writer, always with the owner and label conditions in the query (S1 shared notes).
// - Counts use only what the caller can see (D51, D52.1): a hidden control neither shows nor counts.
// - Anything the caller can't see (another org, a label above their clearance, a control they can't
//   see) is 404 `not_found`, the same as a missing one (D47).
import type { ManagedTransaction } from 'neo4j-driver';
import { z } from 'zod';
import {
  LABELS,
  RECORD_ORIGINS,
  ROLE_TABLE,
  can,
  frameworkSchema,
  requirementSchema,
  type FrameworkRecord,
  type Label,
  type RequirementRecord,
} from '@grc/shared';
import { ApiError } from '../common/errors.js';
import type { Paged } from '../common/paging.js';
import type { GraphService } from '../graph/graph.service.js';
import type { Caller } from '../records/records.service.js';
import {
  byFrameworkThenCode,
  controlQuery,
  controlRequirementsQuery,
  frameworkListQuery,
  frameworkQuery,
  parseRequirementListQuery,
  requirementControlsQuery,
  requirementListQueries,
  requirementMapsToQuery,
  requirementQuery,
  readsAsWriter,
  scopeOf,
  type BuiltQuery,
  type Scope,
} from './framework-queries.js';

/** Neo4j stops a frameworks read after this long (D48). */
export const FRAMEWORK_READ_TIMEOUT_MS = 5000;

const origin = z.enum(RECORD_ORIGINS);
const count = z.int().min(0);

export const frameworkSummarySchema = z.object({
  ...frameworkSchema.shape,
  requirementCount: count,
  coveredCount: count,
  implementedCount: count,
});

export const requirementRowSchema = z.object({
  ...requirementSchema.shape,
  covered: z.boolean(),
  implemented: z.boolean(),
  controlCount: count,
});

export const satisfyingControlSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  code: z.string(),
  controlStatus: z.string(),
  label: z.enum(LABELS),
  status: z.string(),
  origin,
  createdAt: z.string(),
  createdBy: z.string(),
});

export const mapsToItemSchema = z.object({
  direction: z.enum(['out', 'in']),
  id: z.string(),
  number: z.string(),
  code: z.string(),
  title: z.string(),
  framework: z.string(),
});

export const requirementDetailSchema = z.object({
  ...requirementSchema.shape,
  controls: z.array(satisfyingControlSchema),
  mapsTo: z.array(mapsToItemSchema),
});

export const controlRequirementSchema = z.object({
  id: z.string(),
  number: z.string(),
  code: z.string(),
  title: z.string(),
  framework: z.string(),
  group: z.string(),
  status: z.string(),
  origin,
  createdAt: z.string(),
  createdBy: z.string(),
});

export const frameworkListSchema = z.object({ items: z.array(frameworkSummarySchema) });
export const pagedRequirementsSchema = z.object({
  items: z.array(requirementRowSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});
export const controlRequirementListSchema = z.object({ items: z.array(controlRequirementSchema) });

export type FrameworkSummary = z.infer<typeof frameworkSummarySchema>;
export type RequirementRow = z.infer<typeof requirementRowSchema>;
export type SatisfyingControl = z.infer<typeof satisfyingControlSchema>;
export type MapsToItem = z.infer<typeof mapsToItemSchema>;
export type RequirementDetail = z.infer<typeof requirementDetailSchema>;
export type ControlRequirement = z.infer<typeof controlRequirementSchema>;

export interface FrameworksServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
}

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');

type Props = Record<string, unknown>;

/** The fields every catalog record has, as the API returns them (`sensitivity` as `label`). */
function commonOut(p: Props) {
  return {
    id: p['id'] as string,
    number: p['number'] as string,
    sourceIds: (p['sourceIds'] as string[] | undefined) ?? [],
    name: p['name'] as string,
    label: p['sensitivity'] as Label,
    status: p['status'] as FrameworkRecord['status'],
    owner: p['owner'] as string,
    version: Number(p['version']),
    createdAt: p['createdAt'] as string,
    createdBy: p['createdBy'] as string,
    updatedAt: p['updatedAt'] as string,
    updatedBy: p['updatedBy'] as string,
    origin: p['origin'] as FrameworkRecord['origin'],
  };
}

function toFramework(p: Props): FrameworkRecord {
  return {
    ...commonOut(p),
    key: p['key'] as FrameworkRecord['key'],
    frameworkVersion: p['frameworkVersion'] as string,
    publisher: p['publisher'] as string,
    description: p['description'] as string,
  };
}

function toRequirement(p: Props): RequirementRecord {
  return {
    ...commonOut(p),
    code: p['code'] as string,
    title: p['title'] as string,
    description: p['description'] as string,
    framework: p['framework'] as RequirementRecord['framework'],
    group: p['group'] as string,
    parentCode: (p['parentCode'] as string | null | undefined) ?? null,
    sortKey: p['sortKey'] as string,
  };
}

function toSummary(row: { get(key: string): unknown }): FrameworkSummary {
  return {
    ...toFramework(row.get('p') as Props),
    requirementCount: Number(row.get('requirementCount') ?? 0),
    coveredCount: Number(row.get('coveredCount') ?? 0),
    implementedCount: Number(row.get('implementedCount') ?? 0),
  };
}

async function run(tx: ManagedTransaction, q: BuiltQuery) {
  return (await tx.run(q.text, q.params)).records;
}

export class FrameworksService {
  private readonly graph: FrameworksServiceDeps['graph'];

  constructor(deps: FrameworksServiceDeps) {
    this.graph = deps.graph;
  }

  /** Every active framework the caller may see, with its counts for them. */
  async listFrameworks(caller: Caller): Promise<{ items: FrameworkSummary[] }> {
    if (!can(caller.role, 'framework_mapping', 'view')) throw FORBIDDEN();
    const items = await this.read(caller, async (tx, scope) =>
      (await run(tx, frameworkListQuery(scope))).map(toSummary),
    );
    return { items };
  }

  async getFramework(caller: Caller, id: string): Promise<FrameworkSummary> {
    if (!can(caller.role, 'framework_mapping', 'view')) throw NOT_FOUND();
    const [found] = await this.read(caller, (tx, scope) => run(tx, frameworkQuery(id, scope)));
    if (!found) throw NOT_FOUND();
    return toSummary(found);
  }

  /** One framework's requirements, paged, in natural code order, each with its coverage for the
   * caller. The framework itself not visible: 404. */
  async listRequirements(caller: Caller, frameworkId: string, query: unknown): Promise<Paged<RequirementRow>> {
    const q = parseRequirementListQuery(query);
    if (!can(caller.role, 'framework_mapping', 'view')) throw FORBIDDEN();
    const page = await this.read(caller, async (tx, scope) => {
      const [framework] = await run(tx, frameworkQuery(frameworkId, scope));
      if (!framework) return null;
      const key = (framework.get('p') as Props)['key'] as string;
      const built = requirementListQueries(key, q, scope);
      const [counted] = await run(tx, built.count);
      const total = Number(counted?.get('total') ?? 0);
      const items = (await run(tx, built.page)).map((row): RequirementRow => ({
        ...toRequirement(row.get('p') as Props),
        covered: row.get('covered') === true,
        implemented: row.get('implemented') === true,
        controlCount: Number(row.get('controlCount') ?? 0),
      }));
      return { items, page: q.page, pageSize: q.pageSize, total };
    });
    if (!page) throw NOT_FOUND();
    return page;
  }

  /** One requirement with the controls that satisfy it (active and retired) and its cross-framework
   * links in both directions, limited to what the caller can see. */
  async getRequirement(caller: Caller, id: string): Promise<RequirementDetail> {
    if (!can(caller.role, 'framework_mapping', 'view')) throw NOT_FOUND();
    const detail = await this.read(caller, async (tx, scope) => {
      const [found] = await run(tx, requirementQuery(id, scope));
      if (!found) return null;
      const controls = (await run(tx, requirementControlsQuery(id, scope))).map((row): SatisfyingControl => ({
        id: row.get('id') as string,
        number: row.get('number') as string,
        name: row.get('name') as string,
        code: row.get('code') as string,
        controlStatus: row.get('controlStatus') as string,
        label: row.get('label') as Label,
        status: row.get('status') as string,
        origin: row.get('origin') as SatisfyingControl['origin'],
        createdAt: row.get('createdAt') as string,
        createdBy: row.get('createdBy') as string,
      }));
      const mapsTo = (await run(tx, requirementMapsToQuery(id, scope)))
        .map((row) => ({
          direction: (row.get('out') === true ? 'out' : 'in') as MapsToItem['direction'],
          id: row.get('id') as string,
          number: row.get('number') as string,
          code: row.get('code') as string,
          title: row.get('title') as string,
          framework: row.get('framework') as string,
          sortKey: (row.get('sortKey') as string | null) ?? '',
        }))
        .sort((a, b) => (a.direction === b.direction ? byFrameworkThenCode(a, b) : a.direction === 'out' ? -1 : 1))
        .map((m): MapsToItem => ({
          direction: m.direction,
          id: m.id,
          number: m.number,
          code: m.code,
          title: m.title,
          framework: m.framework,
        }));
      return { ...toRequirement(found.get('p') as Props), controls, mapsTo };
    });
    if (!detail) throw NOT_FOUND();
    return detail;
  }

  /** The requirements one control satisfies, in framework then natural code order. A control the
   * caller can't see (another org, a label above their clearance, or, for a Control Owner, not
   * theirs) is 404, as S1's control routes. */
  async controlRequirements(caller: Caller, controlId: string): Promise<{ items: ControlRequirement[] }> {
    if (ROLE_TABLE.control[caller.role] === 'none') throw FORBIDDEN();
    const items = await this.read(caller, async (tx, scope) => {
      const [control] = await run(tx, controlQuery(controlId, scope));
      if (!control) return null;
      return (await run(tx, controlRequirementsQuery(controlId, scope)))
        .map((row) => ({
          id: row.get('id') as string,
          number: row.get('number') as string,
          code: row.get('code') as string,
          title: row.get('title') as string,
          framework: row.get('framework') as string,
          group: row.get('group') as string,
          status: row.get('status') as string,
          sortKey: (row.get('sortKey') as string | null) ?? '',
          origin: row.get('origin') as ControlRequirement['origin'],
          createdAt: row.get('createdAt') as string,
          createdBy: row.get('createdBy') as string,
        }))
        .sort(byFrameworkThenCode)
        .map((r): ControlRequirement => ({
          id: r.id,
          number: r.number,
          code: r.code,
          title: r.title,
          framework: r.framework,
          group: r.group,
          status: r.status,
          origin: r.origin,
          createdAt: r.createdAt,
          createdBy: r.createdBy,
        }));
    });
    if (!items) throw NOT_FOUND();
    return { items };
  }

  /** Runs a read as the caller's read-only account with a time limit, or as the writer when their
   * cell on controls is "own"; every query carries the caller's scope either way. */
  private read<T>(caller: Caller, fn: (tx: ManagedTransaction, scope: Scope) => Promise<T>): Promise<T> {
    const scope = scopeOf(caller);
    if (readsAsWriter(caller.role)) return this.graph.read(caller.orgId, (tx) => fn(tx, scope));
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, (tx) => fn(tx, scope), {
      timeoutMs: FRAMEWORK_READ_TIMEOUT_MS,
    });
  }
}
