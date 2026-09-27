// M0-007 paging helper (D47: lists are paged, with sorting). Unit tests, no database.
// `pageQuerySchema` (Zod): `page` >= 1 (default 1), `pageSize` 1-100 (default 25), optional `sort`.
// Query-string values arrive as text, so numbers are coerced.
import { describe, expect, it } from 'vitest';
import type { Paged } from '../../src/common/paging.js';

type Schema = {
  parse(v: unknown): { page: number; pageSize: number; sort?: string };
  safeParse(v: unknown): { success: boolean };
};

async function schema(): Promise<Schema> {
  const mod = (await import('../../src/common/paging.js')) as { pageQuerySchema?: Schema };
  if (!mod.pageQuerySchema) throw new Error('src/common/paging.ts must export pageQuerySchema');
  return mod.pageQuerySchema;
}

describe('pageQuerySchema', () => {
  it('defaults to page 1 with 25 per page', async () => {
    expect((await schema()).parse({})).toMatchObject({ page: 1, pageSize: 25 });
  });

  it('coerces query-string numbers', async () => {
    expect((await schema()).parse({ page: '3', pageSize: '50' })).toMatchObject({ page: 3, pageSize: 50 });
  });

  it('keeps sort', async () => {
    expect((await schema()).parse({ sort: 'name' }).sort).toBe('name');
  });

  it.each([1, 100])('accepts pageSize %i', async (pageSize) => {
    expect((await schema()).parse({ pageSize }).pageSize).toBe(pageSize);
  });

  it.each([
    ['page 0', { page: 0 }],
    ['page -1', { page: -1 }],
    ['page 1.5', { page: '1.5' }],
    ['page abc', { page: 'abc' }],
    ['pageSize 0', { pageSize: 0 }],
    ['pageSize 101', { pageSize: 101 }],
    ['pageSize 2.5', { pageSize: '2.5' }],
  ])('refuses %s', async (_name, input) => {
    expect((await schema()).safeParse(input).success).toBe(false);
  });
});

describe('Paged<T>', () => {
  it('has items, page, pageSize and total', () => {
    const page: Paged<{ id: string }> = { items: [{ id: 'a' }], page: 1, pageSize: 25, total: 1 };
    expect(Object.keys(page).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
  });
});
