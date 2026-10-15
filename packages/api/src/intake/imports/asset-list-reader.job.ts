// The asset-list reader (S3-006, D44, D53, D72): the `INTAKE_QUEUES.assetListRead` handler. It runs
// in the worker program only (D36), 4 at a time (D72 "read file ×4"), under the intake system
// context (planner's reading R10). For one import in `reading` it:
//   1. reads the stored file from the org's own bucket;
//   2. parses it in the file sandbox (256 MB, 30 s): CSV with our own parser, or a flat JSON list;
//   3. saves the columns, the row count and the first 5 rows as the sample, and sets the import to
//      `needs_mapping`; or, for a file over a limit (50,000 rows, 200 columns), malformed, or
//      stopped by the sandbox, sets it to `failed` with one error `{ row, field: null, code }`.
// The update only applies while the import is still `reading`, so a second run of the same job
// changes nothing more. Log lines hold only codes, counts and IDs, never a cell value, a column name
// or a file name (D163, D164).
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import type { FileStore } from '../../storage/file-store.js';
import {
  MAX_IMPORT_SAMPLE_ROWS,
  documents,
  imports,
  type DocumentRow,
  type ImportRow,
  type ImportRowError,
} from '../intake.schema.js';
import { INTAKE_QUEUES, INTAKE_SYSTEM_CONTEXT } from '../queues.js';
import type { TableLimits, TableRead } from './csv.js';
import { runInSandbox, SandboxError, type SandboxLimits } from './file-sandbox.js';
import type { FlatValue } from './flat-json.js';

/** How many reads the worker runs at once (D72). */
export const ASSET_LIST_READ_CONCURRENCY = 4;

/** At most 50,000 rows and 200 columns; 5 sample rows are kept (S3-006). */
export const ASSET_LIST_LIMITS: Readonly<TableLimits> = Object.freeze({
  maxRows: 50_000,
  maxColumns: 200,
  keepRows: MAX_IMPORT_SAMPLE_ROWS,
});

/** The codes a read fails with. */
export const ASSET_LIST_READ_CODES = [
  'too_many_rows',
  'too_many_columns',
  'malformed',
  'timed_out',
  'too_much_memory',
] as const;
export type AssetListReadCode = (typeof ASSET_LIST_READ_CODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID);

/** The job's data: the org, and the import (or its document, when the import isn't named). */
export const assetListReadJobSchema = z
  .object({ orgId: uuid, importId: uuid.optional(), documentId: uuid.optional() })
  .refine((d) => d.importId !== undefined || d.documentId !== undefined, 'importId or documentId is required');
export type AssetListReadJob = z.infer<typeof assetListReadJobSchema>;

/** What one run did. `skipped`: nothing to do (bad job data, no such import, or already read). */
export type AssetListReadOutcome =
  | { status: 'needs_mapping'; importId: string; rowCount: number; columnCount: number }
  | { status: 'failed'; importId: string; code: AssetListReadCode }
  | { status: 'skipped'; importId?: string; reason: 'bad_job_data' | 'import_not_found' | 'already_read' };

/** Reads a table from a file's bytes; the default is the file sandbox. */
export type TableReader = (format: 'csv' | 'json', bytes: Uint8Array) => Promise<TableRead<FlatValue>>;

// The parser modules sit next to this file, with its own extension (`.ts` from source).
const OWN_EXTENSION = /\.[cm]?[jt]s$/.exec(new URL(import.meta.url).pathname)?.[0] ?? '.js';
const PARSERS = {
  csv: { module: new URL(`./csv${OWN_EXTENSION}`, import.meta.url), exportName: 'parseCsv' },
  json: { module: new URL(`./flat-json${OWN_EXTENSION}`, import.meta.url), exportName: 'parseFlatJson' },
} as const;

/** The default reader: the format's parser in the file sandbox, with the asset-list limits. */
export function sandboxedTableReader(
  limits: Readonly<TableLimits> = ASSET_LIST_LIMITS,
  sandbox: SandboxLimits = {},
): TableReader {
  return (format, bytes) =>
    runInSandbox<TableRead<FlatValue>>({ ...PARSERS[format], input: bytes, args: [{ ...limits }] }, sandbox);
}

export interface AssetListReaderDeps {
  db: Db;
  files: Pick<FileStore, 'get'>;
  readTable?: TableReader;
  log?: Logger;
}

function isReadCode(code: string): code is AssetListReadCode {
  return (ASSET_LIST_READ_CODES as readonly string[]).includes(code);
}

/** One run of the job. Throws only for what a retry may fix (the file store or the database). */
export async function readAssetList(deps: AssetListReaderDeps, data: unknown): Promise<AssetListReadOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'AssetListReader' });
  const readTable = deps.readTable ?? sandboxedTableReader();
  const parsed = assetListReadJobSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ code: 'bad_job_data' }, 'an asset-list read job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const job = parsed.data;
  const ctx = INTAKE_SYSTEM_CONTEXT(job.orgId);

  const found = await withOrgContext(deps.db, ctx, async (tx) => {
    const byImport = job.importId !== undefined;
    const [row] = await tx
      .select({ imp: imports, doc: documents })
      .from(imports)
      .innerJoin(documents, and(eq(documents.orgId, imports.orgId), eq(documents.id, imports.documentId)))
      .where(
        and(
          eq(imports.orgId, job.orgId),
          byImport ? eq(imports.id, job.importId!) : eq(imports.documentId, job.documentId!),
          byImport && job.documentId !== undefined ? eq(imports.documentId, job.documentId) : undefined,
        ),
      )
      .orderBy(desc(imports.createdAt), desc(imports.id))
      .limit(1);
    return row;
  });
  const ids = { orgId: job.orgId, importId: found?.imp.id ?? job.importId, documentId: job.documentId };
  if (!found) {
    log.warn({ ...ids, code: 'import_not_found' }, 'an asset-list read job named no import');
    return { status: 'skipped', reason: 'import_not_found' };
  }
  const { imp, doc } = found;
  if (imp.status !== 'reading') return { status: 'skipped', importId: imp.id, reason: 'already_read' };

  const where = { orgId: job.orgId, importId: imp.id, documentId: doc.id };
  if (doc.format !== 'csv' && doc.format !== 'json') {
    return finish(deps, log, imp, doc, { code: 'malformed', row: 0 });
  }

  let bytes: Buffer;
  try {
    bytes = await deps.files.get(job.orgId, doc.storageKey);
  } catch (err) {
    log.error({ ...where, ...errorKind(err) }, 'the stored file of an asset list could not be read');
    throw err;
  }

  let table: TableRead<FlatValue>;
  try {
    table = await readTable(doc.format, bytes);
  } catch (err) {
    if (err instanceof SandboxError && isReadCode(err.code)) {
      return finish(deps, log, imp, doc, { code: err.code, row: err.row });
    }
    log.error(
      { ...where, ...errorKind(err), code: err instanceof SandboxError ? err.code : undefined },
      'an asset-list read broke',
    );
    throw err;
  }
  return finish(deps, log, imp, doc, table);
}

// Saves the outcome while the import is still `reading`.
async function finish(
  deps: AssetListReaderDeps,
  log: Logger,
  imp: ImportRow,
  doc: DocumentRow,
  outcome: TableRead<FlatValue> | { code: AssetListReadCode; row: number },
): Promise<AssetListReadOutcome> {
  const ids = { orgId: imp.orgId, importId: imp.id, documentId: doc.id };
  const failed = 'code' in outcome;
  const changes = failed
    ? {
        status: 'failed' as const,
        errors: [{ row: outcome.row, field: null, code: outcome.code }] satisfies ImportRowError[],
        updatedAt: new Date(),
      }
    : {
        status: 'needs_mapping' as const,
        columns: outcome.columns,
        sample: outcome.rows.slice(0, MAX_IMPORT_SAMPLE_ROWS),
        rowCount: outcome.rowCount,
        errors: null,
        updatedAt: new Date(),
      };

  const updated = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(imp.orgId), (tx) =>
    tx
      .update(imports)
      .set(changes)
      .where(and(eq(imports.orgId, imp.orgId), eq(imports.id, imp.id), eq(imports.status, 'reading')))
      .returning({ id: imports.id }),
  );
  if (updated.length === 0) return { status: 'skipped', importId: imp.id, reason: 'already_read' };

  if (failed) {
    log.warn({ ...ids, code: outcome.code, row: outcome.row }, 'an asset list could not be read');
    return { status: 'failed', importId: imp.id, code: outcome.code };
  }
  log.info(
    { ...ids, rowCount: outcome.rowCount, columnCount: outcome.columns.length },
    'an asset list was read and waits for its mapping',
  );
  return {
    status: 'needs_mapping',
    importId: imp.id,
    rowCount: outcome.rowCount,
    columnCount: outcome.columns.length,
  };
}

/** Registers the reader in the worker program only; the API program never parses files (D53). */
export class AssetListReaderJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'AssetListReader' });

  constructor(
    private readonly jobs: JobsService,
    private readonly db: Db,
    private readonly files: FileStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: AssetListReaderDeps = { db: this.db, files: this.files, log: this.log };
    await this.jobs.work(
      INTAKE_QUEUES.assetListRead,
      async (job) => {
        await readAssetList(deps, job.data);
      },
      { concurrency: ASSET_LIST_READ_CONCURRENCY },
    );
  }
}
