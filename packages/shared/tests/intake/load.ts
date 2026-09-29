// Loads the S3-001 intake model. A dynamic import keeps a missing file from breaking the whole run:
// each test then fails with a message naming what is missing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INTAKE_DIR = join(SHARED_DIR, 'src', 'intake');

export type Parsed = { success: true; data: unknown } | { success: false; error: { issues: unknown[] } };

/** The part of a Zod schema the tests use. */
export interface Schema {
  safeParse(input: unknown): Parsed;
}

export interface DetectInput {
  fileName: string;
  head: Uint8Array;
  zipEntries?: readonly string[];
  isUtf8Text: boolean;
}

export type DetectResult =
  { ok: true; format: string } | { ok: false; reason: 'zip' | 'unknown_type' | 'extension_mismatch' | 'empty' };

export interface IntakeApi {
  UPLOAD_KINDS: readonly string[];
  DOCUMENT_KINDS: readonly string[];
  isUploadKind(v: unknown): boolean;
  DOCUMENT_RECORD_TYPE: Record<string, string>;
  KIND_FORMATS: Record<string, readonly string[]>;
  FILE_FORMATS: readonly string[];
  FORMAT_CONTENT_TYPES: Record<string, string>;
  MAX_UPLOAD_BYTES: number;
  MAX_FILE_NAME_LENGTH: number;
  detectFileFormat(input: DetectInput): DetectResult;
  DOCUMENT_STATUSES: readonly string[];
  IMPORT_STATUSES: readonly string[];
  ASSET_IMPORT_FIELDS: readonly string[];
  REQUIRED_IMPORT_FIELDS: readonly string[];
  normaliseHeader(h: string): string;
  suggestMapping(headers: readonly string[]): Partial<Record<string, string>>;
  normaliseValue(v: string): string;
  importMappingSchema: Schema;
  pushBatchSchema: Schema;
  canUpload(role: string, kind: string): boolean;
}

export const EXPORTS = [
  'UPLOAD_KINDS',
  'DOCUMENT_KINDS',
  'isUploadKind',
  'DOCUMENT_RECORD_TYPE',
  'KIND_FORMATS',
  'FILE_FORMATS',
  'FORMAT_CONTENT_TYPES',
  'MAX_UPLOAD_BYTES',
  'MAX_FILE_NAME_LENGTH',
  'detectFileFormat',
  'DOCUMENT_STATUSES',
  'IMPORT_STATUSES',
  'ASSET_IMPORT_FIELDS',
  'REQUIRED_IMPORT_FIELDS',
  'normaliseHeader',
  'suggestMapping',
  'normaliseValue',
  'importMappingSchema',
  'pushBatchSchema',
  'canUpload',
] as const;

export async function loadModule(rel: string): Promise<Record<string, unknown>> {
  const file = join(SHARED_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

function checkExports(mod: Record<string, unknown>, rel: string): IntakeApi {
  for (const name of EXPORTS) {
    if (mod[name] === undefined) throw new Error(`${rel} must export ${name}`);
  }
  return mod as unknown as IntakeApi;
}

/** The intake model from `src/intake/index.ts`. */
export async function loadIntake(): Promise<IntakeApi> {
  return checkExports(await loadModule('src/intake/index.ts'), 'src/intake/index.ts');
}

/** The same model through the package entry point, `src/index.ts`. */
export async function loadSharedIntake(): Promise<IntakeApi> {
  return checkExports(await loadModule('src/index.ts'), 'src/index.ts');
}
