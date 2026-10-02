// Loads the S2-001 framework model. A dynamic import keeps a missing file from breaking the whole
// run: each test then fails with a message naming what is missing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FRAMEWORKS_DIR = join(SHARED_DIR, 'src', 'frameworks');

export interface Issue {
  path: PropertyKey[];
  message: string;
}

export type Parsed = { success: true; data: unknown } | { success: false; error: { issues: Issue[] } };

/** The part of a Zod schema the tests use. */
export interface Schema {
  safeParse(input: unknown): Parsed;
}

export interface FrameworkInfo {
  name: string;
  frameworkVersion: string;
  publisher: string;
  description: string;
  groupNames: Record<string, string>;
}

export interface Caller {
  userId: unknown;
  role: unknown;
  clearance: unknown;
}

export interface ControlEnd {
  label: unknown;
  owner: unknown;
}

export interface FrameworksApi {
  FRAMEWORK_KEYS: readonly string[];
  isFrameworkKey(v: unknown): boolean;
  FRAMEWORKS: Record<string, FrameworkInfo>;
  CODE_PATTERNS: Record<string, RegExp>;
  isRequirementCode(key: unknown, code: unknown): boolean;
  groupOf(key: string, code: string): string;
  parentCodeOf(key: string, code: string): string | null;
  sortKeyOf(key: string, code: string): string;
  CATALOG_NAMESPACE: string;
  frameworkIdFor(key: string): string;
  requirementIdFor(key: string, code: string): string;
  CATALOG_NUMBER_PREFIX: Record<string, string>;
  formatCatalogNumber(kind: string, n: number): string;
  parseCatalogNumber(text: unknown): { kind: string; n: number } | null;
  frameworkSchema: Schema;
  requirementSchema: Schema;
  catalogRequirementSchema: Schema;
  catalogMappingSchema: Schema;
  MAPPING_LINK_TYPES: readonly { type: string; from: string; to: string }[];
  canMapControl(caller: Caller, control: ControlEnd): boolean;
}

export const EXPORTS = [
  'FRAMEWORK_KEYS',
  'isFrameworkKey',
  'FRAMEWORKS',
  'CODE_PATTERNS',
  'isRequirementCode',
  'groupOf',
  'parentCodeOf',
  'sortKeyOf',
  'CATALOG_NAMESPACE',
  'frameworkIdFor',
  'requirementIdFor',
  'CATALOG_NUMBER_PREFIX',
  'formatCatalogNumber',
  'parseCatalogNumber',
  'frameworkSchema',
  'requirementSchema',
  'catalogRequirementSchema',
  'catalogMappingSchema',
  'MAPPING_LINK_TYPES',
  'canMapControl',
] as const;

export async function loadModule(rel: string): Promise<Record<string, unknown>> {
  const file = join(SHARED_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

function checkExports(mod: Record<string, unknown>, rel: string): FrameworksApi {
  for (const name of EXPORTS) {
    if (mod[name] === undefined) throw new Error(`${rel} must export ${name}`);
  }
  return mod as unknown as FrameworksApi;
}

/** The framework model from `src/frameworks/index.ts`. */
export async function loadFrameworks(): Promise<FrameworksApi> {
  return checkExports(await loadModule('src/frameworks/index.ts'), 'src/frameworks/index.ts');
}

/** The same model through the package entry point, `src/index.ts`. */
export async function loadShared(): Promise<FrameworksApi> {
  return checkExports(await loadModule('src/index.ts'), 'src/index.ts');
}
