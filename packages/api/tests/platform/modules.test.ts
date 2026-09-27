// M0-007 layout (D36, D46): one codebase, two programs, and the 11 API/worker modules, each a folder
// with a module file that exports its Nest module class.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_DIR } from '../db/helpers.js';

const MODULES = [
  'identity',
  'access',
  'audit',
  'records',
  'frameworks',
  'intake',
  'processing',
  'review',
  'search',
  'chat',
  'ai',
];

const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);

describe('D46 module layout', () => {
  it.each(MODULES)('src/%s has a module file that exports its module class', async (name) => {
    const file = join(API_DIR, 'src', name, `${name}.module.ts`);
    expect(existsSync(file), file).toBe(true);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    expect(typeof mod[`${pascal(name)}Module`], `${pascal(name)}Module`).toBe('function');
  });
});

describe('D36 two programs from one codebase', () => {
  it.each([
    ['src/main.api.ts', 'createApiApp'],
    ['src/main.worker.ts', 'createWorkerApp'],
    ['src/app.module.ts', 'AppModule'],
    ['src/worker.module.ts', 'WorkerModule'],
  ])('%s exports %s', async (rel, name) => {
    const file = join(API_DIR, rel);
    expect(existsSync(file), file).toBe(true);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    expect(typeof mod[name], name).toBe('function');
  });
});
