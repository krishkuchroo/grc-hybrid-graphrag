// Loads the code under test. Dynamic imports keep a missing file from breaking the whole run: each
// test then fails with a message naming what is missing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, Ctx, Label, Role } from './expected.js';

export const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface LinkEnd {
  recordType: string;
  label: Label;
  isOwner?: boolean;
}

export interface AccessApi {
  ROLES: readonly string[];
  LABELS: readonly string[];
  RECORD_TYPES: readonly string[];
  FUNCTIONS: readonly string[];
  ROLE_TABLE: Record<string, Record<string, string>>;
  can(role: string, subject: string, action: Action | string, ctx?: Ctx): boolean;
  isVisible(clearance: Label | string, label: Label | string): boolean;
  isLinkVisible(viewer: { role: Role | string; clearance: Label }, from: LinkEnd, to: LinkEnd): boolean;
  defaultLabel(recordType: string, attrs?: { dataClassification?: Label }): Label;
  canChangeLabel(role: Role | string, from: Label, to: Label): boolean;
}

export const EXPORTS = [
  'ROLES',
  'LABELS',
  'RECORD_TYPES',
  'FUNCTIONS',
  'ROLE_TABLE',
  'can',
  'isVisible',
  'isLinkVisible',
  'defaultLabel',
  'canChangeLabel',
] as const;

async function loadFrom(rel: string): Promise<Record<string, unknown>> {
  const file = join(SHARED_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

export async function loadModule(rel: string): Promise<Record<string, unknown>> {
  return loadFrom(rel);
}

export async function loadAccess(): Promise<AccessApi> {
  const mod = await loadFrom('src/access/index.ts');
  for (const name of EXPORTS) {
    if (mod[name] === undefined) throw new Error(`src/access/index.ts must export ${name}`);
  }
  return mod as unknown as AccessApi;
}
