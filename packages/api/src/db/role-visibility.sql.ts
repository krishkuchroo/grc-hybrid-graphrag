// The role and label checks Postgres adds to the org wall on tables whose rows carry a record type
// and a label (D50, D51, D73: "Documents, chunks and findings also check role and label").
//
// `roleVisibilitySql()` builds, from the D50 table (`ROLE_TABLE`) and `LABELS`, the SQL for two
// functions a migration pastes in as it is:
// - `app_role_views(record_type text) returns boolean`: true when the D50 cell of the context role
//   (`app.role`) for that record type is `view`, `edit` or `approve`. The ownership cells
//   (`edit_own`, `upload_own`) are false, because the database can't know who owns what; so is
//   any role, record type or cell it doesn't know, and so is no role set (fail safe).
// - `app_label_visible(label text) returns boolean`: true when the label's rank is at or below the
//   rank of the context clearance (`app.clearance`). An unknown label or clearance, or none set,
//   is false.
// Neither function reads a table, so neither needs SECURITY DEFINER; both run as the caller.
//
// Pure: no I/O, the same output for the same tables.
import { LABELS, RECORD_TYPES, ROLE_TABLE, ROLES, isRole, type Cell, type RecordType, type Role } from '@grc/shared';

/** The D50 cells that let a role's own context see a record type in Postgres. */
const DB_VIEW_CELLS: ReadonlySet<Cell> = new Set<Cell>(['view', 'edit', 'approve']);

function isRecordType(value: unknown): value is RecordType {
  return typeof value === 'string' && (RECORD_TYPES as readonly string[]).includes(value);
}

/**
 * What `app_role_views` answers for a role and record type: the D50 cell is `view`, `edit` or
 * `approve`. Ownership cells and anything unknown are false.
 */
export function roleViewsInDb(role: string, recordType: string): boolean {
  if (!isRole(role) || !isRecordType(recordType)) return false;
  return DB_VIEW_CELLS.has(ROLE_TABLE[recordType][role]);
}

/** Every (role, record type) pair `app_role_views` answers true for, in `ROLES` × `RECORD_TYPES` order. */
export function roleViewPairs(): ReadonlyArray<readonly [Role, RecordType]> {
  const pairs: Array<readonly [Role, RecordType]> = [];
  for (const role of ROLES) {
    for (const type of RECORD_TYPES) {
      if (roleViewsInDb(role, type)) pairs.push([role, type] as const);
    }
  }
  return pairs;
}

// The names are fixed lists of lowercase words, so they're safe as SQL literals; checked anyway.
function literal(value: string): string {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`roleVisibilitySql: unexpected name '${value}'`);
  return `'${value}'`;
}

/** `CASE <expr> WHEN 'public' THEN 0 … END`: a label's rank, low to high; null when unknown. */
function labelRank(expr: string): string {
  const whens = LABELS.map((label, rank) => `WHEN ${literal(label)} THEN ${rank}`).join(' ');
  return `(CASE ${expr} ${whens} END)`;
}

function roleViewsBody(): string {
  const pairs = roleViewPairs();
  if (pairs.length === 0) return 'SELECT false';
  const list = pairs.map(([role, type]) => `    (${literal(role)}, ${literal(type)})`).join(',\n');
  return [
    `SELECT coalesce(`,
    `  (nullif(current_setting('app.role', true), ''), $1) IN (`,
    list,
    `  ),`,
    `  false`,
    `)`,
  ].join('\n');
}

function labelVisibleBody(): string {
  return [
    `SELECT coalesce(`,
    `  ${labelRank('$1')}`,
    `    <= ${labelRank(`nullif(current_setting('app.clearance', true), '')`)},`,
    `  false`,
    `)`,
  ].join('\n');
}

/**
 * The SQL that creates `app_role_views(text)` and `app_label_visible(text)`, revokes them from
 * PUBLIC and lets grc_app run them. Statements are separated by drizzle-kit's breakpoint marker,
 * so the output pastes into a migration as it is.
 */
export function roleVisibilitySql(): string {
  return [
    `-- True when the context role's D50 cell for the record type is view, edit or approve; ownership\n` +
      `-- cells, unknown values and no role are false (built from ROLE_TABLE by role-visibility.sql.ts).\n` +
      `CREATE FUNCTION app_role_views(record_type text) RETURNS boolean\n` +
      `  LANGUAGE sql STABLE\n` +
      `  SET search_path = pg_catalog\n` +
      `  AS $$\n${roleViewsBody()}\n$$;`,
    `-- True when the label ranks at or below the context clearance; unknown values and no clearance\n` +
      `-- are false (built from LABELS by role-visibility.sql.ts).\n` +
      `CREATE FUNCTION app_label_visible(label text) RETURNS boolean\n` +
      `  LANGUAGE sql STABLE\n` +
      `  SET search_path = pg_catalog\n` +
      `  AS $$\n${labelVisibleBody()}\n$$;`,
    `REVOKE ALL ON FUNCTION app_role_views(text) FROM PUBLIC;`,
    `REVOKE ALL ON FUNCTION app_label_visible(text) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION app_role_views(text) TO grc_app;`,
    `GRANT EXECUTE ON FUNCTION app_label_visible(text) TO grc_app;`,
  ].join('\n--> statement-breakpoint\n');
}
