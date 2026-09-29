// Loads the S3-016 world module. A dynamic import keeps a missing file from breaking the whole run:
// each test then fails with a message naming what is missing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORLD_DIR = join(GENERATORS_DIR, 'src', 'world');

export const KINDS = ['asset', 'risk', 'control', 'policy', 'incident'] as const;
export type Kind = (typeof KINDS)[number];

/** The org's record list for each kind (the brief's `WorldOrg`). */
export const LIST_OF = {
  asset: 'assets',
  risk: 'risks',
  control: 'controls',
  policy: 'policies',
  incident: 'incidents',
} as const satisfies Record<Kind, string>;

export interface SizeSpec {
  orgs: number;
  assets: number;
  risks: number;
  controls: number;
  policies: number;
  incidents: number;
}

export const SIZE_FIELDS = ['orgs', 'assets', 'risks', 'controls', 'policies', 'incidents'] as const;

export interface WorldRecord {
  key: string;
  name: string;
  [field: string]: unknown;
}

export interface WorldLink {
  type: string;
  fromKey: string;
  toKey: string;
}

export interface WorldOrg {
  key: string;
  name: string;
  assets: WorldRecord[];
  risks: WorldRecord[];
  controls: WorldRecord[];
  policies: WorldRecord[];
  incidents: WorldRecord[];
  links: WorldLink[];
}

export interface AnswerKey {
  generatorVersion: string;
  seed: number;
  size: SizeSpec;
  orgs: WorldOrg[];
}

export interface WorldApi {
  SIZES: { tiny: SizeSpec; accuracy: SizeSpec; stress: SizeSpec };
  parseSize(text: string): SizeSpec;
  GENERATOR_VERSION: string;
  buildWorld(input: { seed: number; size: SizeSpec }): AnswerKey;
}

export const EXPORTS = ['SIZES', 'parseSize', 'GENERATOR_VERSION', 'buildWorld'] as const;

export async function loadModule(rel: string): Promise<Record<string, unknown>> {
  const file = join(GENERATORS_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

function checkExports(mod: Record<string, unknown>, rel: string): WorldApi {
  for (const name of EXPORTS) {
    if (mod[name] === undefined) throw new Error(`${rel} must export ${name}`);
  }
  return mod as unknown as WorldApi;
}

/** The world from `src/world/index.ts`. */
export async function loadWorld(): Promise<WorldApi> {
  return checkExports(await loadModule('src/world/index.ts'), 'src/world/index.ts');
}

/** The same through the package entry point, `src/index.ts`. */
export async function loadGenerators(): Promise<WorldApi> {
  return checkExports(await loadModule('src/index.ts'), 'src/index.ts');
}
