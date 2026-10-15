// Our flat JSON reader for asset lists (D44): the file is one JSON array of flat objects, each
// value a string, number, boolean or null. The columns are the union of the objects' keys in
// first-seen order; a row keeps only its own keys. A UTF-8 BOM is dropped and the bytes must be
// valid UTF-8. Keys must be non-blank. Anything else (not JSON, not an array, an element that isn't
// an object, a nested object or array) is `malformed`. Rows are counted from 1 (0 is the whole file).
//
// Only the worker runs this, inside the file sandbox (D53). Like csv.ts it imports no other module
// of ours (only types, which are erased), so the sandbox's Worker can load it by itself; the error
// and the limits are the same as csv.ts's.
import type { TableLimits, TableRead, TableReadCode, TableReadError } from './csv.js';

/** A flat value: what a cell of a flat JSON list may hold. */
export type FlatValue = string | number | boolean | null;

/** At most 50,000 rows and 200 columns (S3-006), as csv.ts. */
export const FLAT_JSON_DEFAULT_LIMITS: Readonly<TableLimits> = Object.freeze({
  maxRows: 50_000,
  maxColumns: 200,
  keepRows: Number.POSITIVE_INFINITY,
});

function tableReadError(code: TableReadCode, row: number): TableReadError {
  const err = new Error(`The file could not be read (${code}).`) as TableReadError;
  err.name = 'TableReadError';
  err.code = code;
  err.row = row;
  return err;
}

function decode(input: string | Uint8Array): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw tableReadError('malformed', 0);
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isFlatValue(v: unknown): v is FlatValue {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Reads a flat JSON list into its columns, rows and row count. Throws a `TableReadError` with
 * `malformed`, `too_many_rows` (at row `maxRows + 1`) or `too_many_columns` (at the row that
 * brought the column count over).
 */
export function parseFlatJson(input: string | Uint8Array, limits?: Partial<TableLimits>): TableRead<FlatValue> {
  const { maxRows, maxColumns, keepRows } = { ...FLAT_JSON_DEFAULT_LIMITS, ...limits };
  const text = decode(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw tableReadError('malformed', 0);
  }
  if (!Array.isArray(parsed)) throw tableReadError('malformed', 0);
  if (parsed.length > maxRows) throw tableReadError('too_many_rows', maxRows + 1);

  const columns: string[] = [];
  const known = new Set<string>();
  const rows: Array<Record<string, FlatValue>> = [];
  parsed.forEach((item: unknown, index) => {
    const row = index + 1;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw tableReadError('malformed', row);
    const entries = Object.entries(item as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (key.trim() === '' || !isFlatValue(value)) throw tableReadError('malformed', row);
      if (!known.has(key)) {
        known.add(key);
        columns.push(key);
        if (columns.length > maxColumns) throw tableReadError('too_many_columns', row);
      }
    }
    if (rows.length < keepRows) rows.push(Object.fromEntries(entries) as Record<string, FlatValue>);
  });

  return { columns, rows, rowCount: parsed.length };
}
