// The frameworks read queries (S2-004): the Cypher and the list and filter building for the read
// side of Frameworks (D47). Every name put into the Cypher text comes from the fixed lists below;
// every value the caller sends goes in as a parameter (D52.2). Each query carries the caller's
// scope (D50, D51): a catalog node (Framework, Requirement) must be at or below their clearance,
// and a control must be one their role may view (for a Control Owner, one they own) at or below
// their clearance. The read runs as the caller's read-only role x clearance account, so Neo4j
// checks the same again and hides every link with a hidden end (D45.3, D59); a Control Owner's
// reads run as the writer with the owner and label conditions in the query (S1 shared notes).
// Coverage (S2 shared notes): a requirement is covered when at least one active control the caller
// can see satisfies it, and implemented when one of those controls is `implemented`.
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { FRAMEWORKS, FRAMEWORK_KEYS, ROLE_TABLE, can, type Label, type Role } from '@grc/shared';
import { pageQuerySchema } from '../common/paging.js';
import { visibleLabels } from '../records/record-queries.js';

export const COVERAGE_FILTERS = ['covered', 'not_covered', 'implemented'] as const;
export const REQUIREMENT_STATUS_FILTERS = ['active', 'retired', 'all'] as const;
export const REQUIREMENT_SORTS = ['code', '-code'] as const;

export type CoverageFilter = (typeof COVERAGE_FILTERS)[number];

/** Every group code of every framework (`AC`, `GV.OC`, `A.5`, `CC6`): the only values `group` takes. */
export const GROUP_CODES = Object.freeze([
  ...new Set(FRAMEWORK_KEYS.flatMap((key) => Object.keys(FRAMEWORKS[key].groupNames))),
]) as readonly [string, ...string[]];

/** The query string of GET /api/v1/frameworks/:id/requirements. Unknown filters, sorts and values
 * are refused (a ZodError, answered as 400). */
export const requirementListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  sort: z.enum(REQUIREMENT_SORTS).default('code'),
  status: z.enum(REQUIREMENT_STATUS_FILTERS).default('active'),
  coverage: z.enum(COVERAGE_FILTERS).optional(),
  group: z.enum(GROUP_CODES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export type RequirementListQuery = z.infer<typeof requirementListQuerySchema>;

export function parseRequirementListQuery(query: unknown): RequirementListQuery {
  return requirementListQuerySchema.parse(query ?? {});
}

/** Who is reading. */
export interface ScopeCaller {
  userId: string;
  role: Role;
  clearance: Label;
}

/** The caller's scope as Cypher conditions on a node variable, with the parameters they use. */
export interface Scope {
  /** A Framework or Requirement node the caller may see. */
  catalog(v: string): string;
  /** A Control node the caller may see: their role's cell on controls, and their clearance. */
  control(v: string): string;
  params: { visible: Label[]; self: string };
}

export function scopeOf(caller: ScopeCaller): Scope {
  const catalogOk = can(caller.role, 'framework_mapping', 'view');
  const cell = ROLE_TABLE.control[caller.role];
  return {
    catalog: (v) => (catalogOk ? `${v}.sensitivity IN $visible` : 'false'),
    control: (v) => {
      if (cell === 'view' || cell === 'edit') return `${v}.sensitivity IN $visible`;
      if (cell === 'edit_own') return `(${v}.sensitivity IN $visible AND ${v}.owner = $self)`;
      return 'false';
    },
    params: { visible: visibleLabels(caller.clearance), self: caller.userId },
  };
}

/** Whether the caller's reads must run as the writer: only when their cell on controls is "own",
 * because no shared read-only account can know who owns what (S1 shared notes). */
export function readsAsWriter(role: Role): boolean {
  return ROLE_TABLE.control[role] === 'edit_own';
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

/** The counts of one framework `f` for the caller: active requirements, and how many of them an
 * active visible control covers or implements. */
function frameworkCounts(scope: Scope): string {
  return `
    OPTIONAL MATCH (n:Requirement {framework: f.key}) WHERE ${scope.catalog('n')} AND n.status = 'active'
    OPTIONAL MATCH (c:Control)-[:SATISFIES]->(n) WHERE ${scope.control('c')} AND c.status = 'active'
    WITH f, n, collect(c) AS cs
    WITH f, n, size(cs) > 0 AS covered, any(c IN cs WHERE c.controlStatus = 'implemented') AS implemented
    WITH f, count(n) AS requirementCount,
      sum(CASE WHEN covered THEN 1 ELSE 0 END) AS coveredCount,
      sum(CASE WHEN implemented THEN 1 ELSE 0 END) AS implementedCount
    RETURN properties(f) AS p, requirementCount, coveredCount, implementedCount`;
}

/** Every active framework the caller may see, with its counts, in number order. */
export function frameworkListQuery(scope: Scope): BuiltQuery {
  return {
    text: `MATCH (f:Framework) WHERE ${scope.catalog('f')} AND f.status = 'active'${frameworkCounts(scope)}
    ORDER BY f.number, f.id`,
    params: { ...scope.params },
  };
}

/** One framework by ID, if the caller may see it, with its counts. */
export function frameworkQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (f:Framework {id: $id}) WHERE ${scope.catalog('f')}${frameworkCounts(scope)}`,
    params: { ...scope.params, id },
  };
}

const COVERAGE_WHERE: Readonly<Record<CoverageFilter, string>> = {
  covered: 'covered',
  not_covered: 'NOT covered',
  implemented: 'implemented',
};

/** The count and page queries of one framework's requirements, for a checked list query. Each row
 * carries the visible controls that satisfy it (`controlCount`, active or retired) and whether an
 * active one covers or implements it. */
export function requirementListQueries(
  frameworkKey: string,
  q: RequirementListQuery,
  scope: Scope,
): { count: BuiltQuery; page: BuiltQuery } {
  const params: Record<string, unknown> = { ...scope.params, key: frameworkKey };
  const where = [scope.catalog('n')];
  if (q.status !== 'all') {
    params['status'] = q.status;
    where.push('n.status = $status');
  }
  if (q.group !== undefined) {
    params['group'] = q.group;
    where.push('n.group = $group');
  }
  if (q.q !== undefined) {
    params['q'] = q.q.toLowerCase();
    where.push('(toLower(n.code) CONTAINS $q OR toLower(n.title) CONTAINS $q)');
  }
  const coverage = q.coverage === undefined ? '' : ` WHERE ${COVERAGE_WHERE[q.coverage]}`;
  const match = `MATCH (n:Requirement {framework: $key}) WHERE ${where.join(' AND ')}
    OPTIONAL MATCH (c:Control)-[:SATISFIES]->(n) WHERE ${scope.control('c')}
    WITH n, collect(c) AS cs
    WITH n, size(cs) AS controlCount,
      any(c IN cs WHERE c.status = 'active') AS covered,
      any(c IN cs WHERE c.status = 'active' AND c.controlStatus = 'implemented') AS implemented${coverage}`;
  const dir = q.sort.startsWith('-') ? 'DESC' : 'ASC';
  return {
    count: { text: `${match} RETURN count(n) AS total`, params },
    page: {
      text: `${match}
    RETURN properties(n) AS p, controlCount, covered, implemented
    ORDER BY n.sortKey ${dir}, n.code ${dir} SKIP $skip LIMIT $limit`,
      params: { ...params, skip: neo4j.int((q.page - 1) * q.pageSize), limit: neo4j.int(q.pageSize) },
    },
  };
}

/** One requirement by ID, if the caller may see it. */
export function requirementQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (n:Requirement {id: $id}) WHERE ${scope.catalog('n')} RETURN properties(n) AS p`,
    params: { ...scope.params, id },
  };
}

/** The controls that satisfy one requirement and the caller can see, active and retired, with
 * each SATISFIES link's origin, time and author. */
export function requirementControlsQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (c:Control)-[r:SATISFIES]->(n:Requirement {id: $id})
    WHERE ${scope.catalog('n')} AND ${scope.control('c')}
    RETURN c.id AS id, c.number AS number, c.name AS name, c.code AS code, c.controlStatus AS controlStatus,
      c.sensitivity AS label, c.status AS status, r.origin AS origin, r.createdAt AS createdAt, r.createdBy AS createdBy
    ORDER BY c.number, c.id, r.createdAt`,
    params: { ...scope.params, id },
  };
}

/** The MAPS_TO links of one requirement in both directions, to requirements the caller can see. */
export function requirementMapsToQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (n:Requirement {id: $id})-[r:MAPS_TO]-(o:Requirement)
    WHERE ${scope.catalog('n')} AND ${scope.catalog('o')}
    RETURN startNode(r) = n AS out, o.id AS id, o.number AS number, o.code AS code, o.title AS title,
      o.framework AS framework, o.sortKey AS sortKey
    ORDER BY out DESC, o.framework, o.sortKey, o.code`,
    params: { ...scope.params, id },
  };
}

/** One control by ID, if the caller may see it. */
export function controlQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (c:Control {id: $id}) WHERE ${scope.control('c')} RETURN c.id AS id`,
    params: { ...scope.params, id },
  };
}

/** The requirements one control satisfies that the caller can see, with each link's origin, time
 * and author. */
export function controlRequirementsQuery(id: string, scope: Scope): BuiltQuery {
  return {
    text: `MATCH (c:Control {id: $id})-[r:SATISFIES]->(n:Requirement)
    WHERE ${scope.control('c')} AND ${scope.catalog('n')}
    RETURN n.id AS id, n.number AS number, n.code AS code, n.title AS title, n.framework AS framework,
      n.group AS group, n.status AS status, n.sortKey AS sortKey, r.origin AS origin, r.createdAt AS createdAt,
      r.createdBy AS createdBy
    ORDER BY n.framework, n.sortKey, n.code`,
    params: { ...scope.params, id },
  };
}

/** Framework order as the project lists the frameworks (FRAMEWORK_KEYS), then natural code order. */
export function byFrameworkThenCode(
  a: { framework: string; sortKey: string; code: string },
  b: { framework: string; sortKey: string; code: string },
): number {
  const rank = (key: string): number => {
    const i = (FRAMEWORK_KEYS as readonly string[]).indexOf(key);
    return i < 0 ? FRAMEWORK_KEYS.length : i;
  };
  return (
    rank(a.framework) - rank(b.framework) ||
    a.framework.localeCompare(b.framework) ||
    a.sortKey.localeCompare(b.sortKey) ||
    a.code.localeCompare(b.code)
  );
}
