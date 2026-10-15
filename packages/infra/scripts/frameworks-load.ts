// `pnpm frameworks:load` (S2-003; D45.5, D66, D133, D164, D170): loads the framework catalogs and
// NIST's MAPS_TO links into every existing org, so a catalog update reaches every org (D66). The
// orgs are found the way `pnpm graph:schema` and the outbox relay find them
// (`AuditService.orgIds()`: every org with an audit partition). Each org gets one line per
// framework (its key and counts), one line for its MAPS_TO links, and OK or failed: only org IDs,
// framework keys, counts and error types, never a title or description (D164). A failed org
// doesn't stop the others; the exit code is 1 if any failed. Safe to re-run: an org whose catalogs
// are current changes nothing and gets no audit entry.
// Settings and the D170 host swap: see org-script-env.ts.
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;

interface FrameworkCounts {
  key: string;
  added: number;
  updated: number;
  retired: number;
  unchanged: number;
}
interface LoadReport {
  frameworks: FrameworkCounts[];
  mapsTo: { added: number; retired: number };
}
interface AuditModule {
  AuditService: new (db: unknown) => { orgIds(): Promise<string[]> };
}
interface OutboxModule {
  AuditOutbox: new (graph: unknown) => object;
}
interface CatalogFilesModule {
  readCatalogFiles(): unknown;
  CatalogFileError: new (...args: never[]) => Error & { file: string; entry: string };
}
interface LoaderModule {
  loadFrameworkCatalogs(deps: { outbox: object }, orgId: string, catalogs: unknown): Promise<LoadReport>;
}

const NAME = 'frameworks:load';

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`${NAME}: missing settings (environment or .env): ${missing.join(', ')}`);
  process.exit(2);
}

const { AuditService } = await load<AuditModule>('audit/audit.service.ts');
const { AuditOutbox } = await load<OutboxModule>('audit/outbox.ts');
const { readCatalogFiles, CatalogFileError } = await load<CatalogFilesModule>('frameworks/catalog-files.ts');
const { loadFrameworkCatalogs } = await load<LoaderModule>('frameworks/catalog-loader.ts');

// The files are read and checked once, before any org is touched. A bad file stops the run: its
// error names the file and the entry (a code or an index), never its text.
let catalogs: unknown;
try {
  catalogs = readCatalogFiles();
} catch (err) {
  if (err instanceof CatalogFileError) {
    console.error(`${NAME}: the catalog files failed their checks: ${err.file} ${err.entry}. No org was changed.`);
  } else {
    console.error(`${NAME}: the catalog files could not be read: ${describeError(err)}. No org was changed.`);
  }
  process.exit(1);
}

function countsLine(c: FrameworkCounts): string {
  return `${c.key} added ${c.added}, updated ${c.updated}, retired ${c.retired}, unchanged ${c.unchanged}`;
}

const conn = await connect();
try {
  const orgIds = await new AuditService(conn.deps.db).orgIds();
  const outbox = new AuditOutbox(conn.deps.graph);
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const report = await loadFrameworkCatalogs({ outbox }, orgId, catalogs);
      for (const counts of report.frameworks) console.log(`${NAME}: ${orgId} ${countsLine(counts)}`);
      console.log(`${NAME}: ${orgId} MAPS_TO added ${report.mapsTo.added}, removed ${report.mapsTo.retired}`);
      console.log(`${NAME}: ${orgId} OK`);
    } catch (err) {
      failed++;
      console.error(`${NAME}: ${orgId} failed: ${describeError(err)}`);
    }
  }
  console.log(`${NAME}: ${orgIds.length - failed} of ${orgIds.length} orgs OK`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error(`${NAME}: failed: ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
