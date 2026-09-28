// Loads the S1-001 record model. A dynamic import keeps a missing file from breaking the whole run:
// each test then fails with a message naming what is missing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORDS_DIR = join(SHARED_DIR, 'src', 'records');

export const KINDS = ['asset', 'risk', 'control', 'policy', 'incident'] as const;
export type Kind = (typeof KINDS)[number];

export interface Issue {
  path: PropertyKey[];
  message: string;
  keys?: string[];
}

export type Parsed = { success: true; data: unknown } | { success: false; error: { issues: Issue[] } };

/** The part of a Zod schema the tests use. */
export interface Schema {
  safeParse(input: unknown): Parsed;
}

export interface RecordsApi {
  RECORD_KINDS: readonly string[];
  RECORD_PATHS: Record<string, string>;
  NODE_LABELS: Record<string, string>;
  createSchemas: Record<Kind, Schema>;
  updateSchemas: Record<Kind, Schema>;
  recordSchemas: Record<Kind, Schema>;
  ASSET_TYPES: readonly string[];
  CRITICALITIES: readonly string[];
  CONTROL_STATUSES: readonly string[];
  INCIDENT_SEVERITIES: readonly string[];
  INCIDENT_STATUSES: readonly string[];
  RISK_SCALE: readonly number[];
  NUMBER_PREFIX: Record<string, string>;
  FIRST_NUMBER: number;
  formatNumber(kind: string, n: number): string;
  parseNumber(text: string): { kind: string; n: number } | null;
  riskRating(impact: number, likelihood: number): { score: number; band: string };
  LINK_TYPES: readonly { type: string; from: string; to: string }[];
  isAllowedLink(type: string, fromKind: string, toKind: string): boolean;
  linkTypesBetween(fromKind: string, toKind: string): readonly string[];
}

export const EXPORTS = [
  'RECORD_KINDS',
  'RECORD_PATHS',
  'NODE_LABELS',
  'createSchemas',
  'updateSchemas',
  'recordSchemas',
  'ASSET_TYPES',
  'CRITICALITIES',
  'CONTROL_STATUSES',
  'INCIDENT_SEVERITIES',
  'INCIDENT_STATUSES',
  'RISK_SCALE',
  'NUMBER_PREFIX',
  'FIRST_NUMBER',
  'formatNumber',
  'parseNumber',
  'riskRating',
  'LINK_TYPES',
  'isAllowedLink',
  'linkTypesBetween',
] as const;

export async function loadModule(rel: string): Promise<Record<string, unknown>> {
  const file = join(SHARED_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

function checkExports(mod: Record<string, unknown>, rel: string): RecordsApi {
  for (const name of EXPORTS) {
    if (mod[name] === undefined) throw new Error(`${rel} must export ${name}`);
  }
  return mod as unknown as RecordsApi;
}

/** The record model from `src/records/index.ts`. */
export async function loadRecords(): Promise<RecordsApi> {
  return checkExports(await loadModule('src/records/index.ts'), 'src/records/index.ts');
}

/** The same model through the package entry point, `src/index.ts`. */
export async function loadShared(): Promise<RecordsApi> {
  return checkExports(await loadModule('src/index.ts'), 'src/index.ts');
}
