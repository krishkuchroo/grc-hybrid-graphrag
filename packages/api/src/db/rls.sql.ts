// The standard org-wall policy (D73), as SQL for a migration.
//
// The rule for every org table: it has `org_id uuid not null`, ENABLE and FORCE ROW LEVEL
// SECURITY, and this policy:
// - SELECT where `app_visible_org(org_id)`: your org, plus orgs you hold an active read-only
//   grant, approved parent link or open break-glass session for.
// - INSERT, UPDATE and DELETE only where `org_id = app_org_id()`, the org in `app.org_id`.
// The policies apply to grc_app, the runtime account (D57). With no org context set,
// `app_org_id()` is null, so nothing is visible and nothing can be written.
//
// `orgColumn` is `org_id` for every org table except `organization`, whose own `id` is the org.

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`orgTablePolicySql: bad identifier '${name}'`);
  return `"${name}"`;
}

export function orgTablePolicySql(table: string, orgColumn = 'org_id'): string {
  const t = ident(table);
  const col = ident(orgColumn);
  const p = (suffix: string): string => ident(`${table}_org_${suffix}`);
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${p('select')} ON ${t} FOR SELECT TO grc_app USING (app_visible_org(${col}));`,
    `CREATE POLICY ${p('insert')} ON ${t} FOR INSERT TO grc_app WITH CHECK (${col} = app_org_id());`,
    `CREATE POLICY ${p('update')} ON ${t} FOR UPDATE TO grc_app USING (${col} = app_org_id()) WITH CHECK (${col} = app_org_id());`,
    `CREATE POLICY ${p('delete')} ON ${t} FOR DELETE TO grc_app USING (${col} = app_org_id());`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO grc_app;`,
  ].join('\n');
}
