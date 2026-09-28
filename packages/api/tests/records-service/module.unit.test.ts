// S1-003 "Files": `RecordsModule` provides `RecordsService` and exports it, so S1-004's controllers
// (and later slices) get it through Nest's DI. Read from Nest's module metadata; nothing connects.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

async function load(): Promise<{ RecordsModule: object; RecordsService: unknown }> {
  const mod = (await import('../../src/records/records.module.js')) as Record<string, unknown>;
  // Not yet written when this test was: loaded by a path the type check doesn't resolve.
  const servicePath = '../../src/records/records.service.js';
  const svc = (await import(/* @vite-ignore */ servicePath)) as Record<string, unknown>;
  if (typeof svc['RecordsService'] !== 'function')
    throw new Error('src/records/records.service.ts must export RecordsService');
  return { RecordsModule: mod['RecordsModule'] as object, RecordsService: svc['RecordsService'] };
}

function provides(entries: unknown[], token: unknown): boolean {
  return entries.some(
    (p) => p === token || (typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === token),
  );
}

describe('RecordsModule', () => {
  it('provides RecordsService', async () => {
    const { RecordsModule, RecordsService } = await load();
    const providers = (Reflect.getMetadata('providers', RecordsModule) ?? []) as unknown[];
    expect(provides(providers, RecordsService)).toBe(true);
  });

  it('exports RecordsService', async () => {
    const { RecordsModule, RecordsService } = await load();
    const exported = (Reflect.getMetadata('exports', RecordsModule) ?? []) as unknown[];
    expect(provides(exported, RecordsService)).toBe(true);
  });
});
