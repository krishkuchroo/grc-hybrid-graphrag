// S3-001 criterion 4 (D47, D30): `pushBatchSchema` is strict `{ batchId, source, rows }`.
//   - batchId: 1-200 characters of [A-Za-z0-9._:-].
//   - source: 1-100 characters of letters, digits, space, `_`, `-` and `.` (as importMappingSchema).
//   - rows: 1-5,000 flat objects whose values are strings, numbers, booleans or null.
import { describe, expect, it } from 'vitest';
import { loadIntake } from './load.js';

const ROW = { sys_id: 'a1b2c3', name: 'web01', tier: 2, in_service: true, notes: null };
const VALID = { batchId: 'cmdb-2026-09-29:001', source: 'servicenow', rows: [ROW] };

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ sys_id: `id-${i}`, name: `host-${i}` }));

describe('criterion 4: pushBatchSchema', () => {
  it.each([
    ['one flat row', VALID],
    ['5,000 rows', { ...VALID, rows: rows(5000) }],
    ['a 1-character batchId', { ...VALID, batchId: 'a' }],
    ['a 200-character batchId', { ...VALID, batchId: 'b'.repeat(200) }],
    ['a batchId using every allowed character', { ...VALID, batchId: 'AZaz09._:-' }],
    ['a source with space, _, - and .', { ...VALID, source: 'Qualys_scan-2026.09 EU' }],
    ['an empty row object', { ...VALID, rows: [{}] }],
  ])('accepts %s', async (_name, input) => {
    const { pushBatchSchema } = await loadIntake();
    expect(pushBatchSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['a nested object value', { ...VALID, rows: [{ ...ROW, meta: { a: 1 } }] }],
    ['an array value', { ...VALID, rows: [{ ...ROW, tags: ['a', 'b'] }] }],
    ['a nested value in a later row', { ...VALID, rows: [ROW, ROW, { ...ROW, meta: {} }] }],
    ['0 rows', { ...VALID, rows: [] }],
    ['5,001 rows', { ...VALID, rows: rows(5001) }],
    ['a row that is a string', { ...VALID, rows: ['web01'] }],
    ['a row that is an array', { ...VALID, rows: [['a1', 'web01']] }],
    ['a row that is null', { ...VALID, rows: [null] }],
    ['rows that are not an array', { ...VALID, rows: ROW }],
    ['an empty batchId', { ...VALID, batchId: '' }],
    ['a 201-character batchId', { ...VALID, batchId: 'b'.repeat(201) }],
    ['a batchId with a space', { ...VALID, batchId: 'batch 1' }],
    ['a batchId with a slash', { ...VALID, batchId: 'batch/1' }],
    ['a batchId with a quote', { ...VALID, batchId: "batch'1" }],
    ['a batchId that is a number', { ...VALID, batchId: 1 }],
    ['no batchId', { source: VALID.source, rows: VALID.rows }],
    ['an empty source', { ...VALID, source: '' }],
    ['a 101-character source', { ...VALID, source: 's'.repeat(101) }],
    ['a source with a slash', { ...VALID, source: 'cmdb/prod' }],
    ['no source', { batchId: VALID.batchId, rows: VALID.rows }],
    ['no rows', { batchId: VALID.batchId, source: VALID.source }],
    ['an unknown top-level field', { ...VALID, orgId: 'org-1' }],
    ['an unknown top-level field named mapping', { ...VALID, mapping: { sourceId: 'sys_id' } }],
    ['not an object', [VALID]],
  ])('refuses %s', async (_name, input) => {
    const { pushBatchSchema } = await loadIntake();
    expect(pushBatchSchema.safeParse(input).success).toBe(false);
  });
});
