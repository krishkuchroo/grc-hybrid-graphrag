// `pnpm graph:schema` (S1-002; D45.5, D73, D133, D164, D170): applies the D73 graph schema to every
// existing org. The orgs are found the way the outbox relay finds them (`AuditService.orgIds()`:
// every org with an audit partition). Each org gets one line: its ID and OK or failed, never a
// value. A failed org doesn't stop the others; the exit code is 1 if any failed. Safe to re-run.
// Settings and the D170 host swap: see org-script-env.ts.
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, missingSettings } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;

interface AuditModule {
  AuditService: new (db: unknown) => { orgIds(): Promise<string[]> };
}
interface OrgSchemaModule {
  ensureOrgSchema(graph: unknown, orgId: string): Promise<void>;
}

const API_SRC = new URL('../../api/src/', import.meta.url);
const { AuditService } = (await import(new URL('audit/audit.service.ts', API_SRC).href)) as AuditModule;
const { ensureOrgSchema } = (await import(new URL('graph/org-schema.ts', API_SRC).href)) as OrgSchemaModule;

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`graph:schema: missing settings (environment or .env): ${missing.join(', ')}`);
  process.exit(2);
}

const conn = await connect();
try {
  const orgIds = await new AuditService(conn.deps.db).orgIds();
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      await ensureOrgSchema(conn.deps.graph, orgId);
      console.log(`graph:schema: ${orgId} OK`);
    } catch (err) {
      failed++;
      console.error(`graph:schema: ${orgId} failed: ${describeError(err)}`);
    }
  }
  console.log(`graph:schema: ${orgIds.length - failed} of ${orgIds.length} orgs OK`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error(`graph:schema: failed: ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
