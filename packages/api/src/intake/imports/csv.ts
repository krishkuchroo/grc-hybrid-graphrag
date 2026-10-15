// Our own CSV reader for asset lists (D44, planner's reading R8: no new package), after RFC 4180:
// - fields are separated by commas and records end with CRLF, LF or a lone CR;
// - a field that starts with `"` is quoted: it may hold commas, line breaks and `""` (one `"`), and
//   its closing quote must be followed by a comma, a line end or the end of the file;
// - a `"` inside an unquoted field is kept as it is;
// - a UTF-8 BOM at the start is dropped, and the bytes must be valid UTF-8;
// - the first record is the header: its names must be non-blank and distinct;
// - empty lines are skipped; a short row's missing cells are empty; a long row is refused unless its
//   extra cells are all empty.
// Anything else (an unclosed quote, text after a closing quote, a bad header, bad UTF-8) is
// `malformed`. Rows are counted from 1 after the header (the header is row 0).
//
// Only the worker runs this, inside the file sandbox (D53). The file imports no other module of
// ours on purpose: the sandbox's Worker loads it by itself, and in a plain Node process type
// stripping can't follow a relative `.js` import to a `.ts` file. So the error and the limits are
// declared here, and the same ones in flat-json.ts.

/** The codes a read is refused with. */
export type TableReadCode = 'too_many_rows' | 'too_many_columns' | 'malformed';

/** How much a read may hold: rows after the header, columns, and how many rows to keep. */
export interface TableLimits {
  maxRows: number;
  maxColumns: number;
  /** How many rows to return (all of them by default); the rest are only counted. */
  keepRows: number;
}

/** The columns in file order, the first `keepRows` rows keyed by column, and the row count. */
export interface TableRead<V> {
  columns: string[];
  rows: Array<Record<string, V>>;
  rowCount: number;
}

/** A refused read: its code and the row it was found at (0 for the header or the whole file). It
 * never carries a cell value or a column name (D163). */
export interface TableReadError extends Error {
  code: TableReadCode;
  row: number;
}

/** At most 50,000 rows and 200 columns (S3-006). */
export const CSV_DEFAULT_LIMITS: Readonly<TableLimits> = Object.freeze({
  maxRows: 50_000,
  maxColumns: 200,
  keepRows: Number.POSITIVE_INFINITY,
});

export function tableReadError(code: TableReadCode, row: number): TableReadError {
  const err = new Error(`The file could not be read (${code}).`) as TableReadError;
  err.name = 'TableReadError';
  err.code = code;
  err.row = row;
  return err;
}

const COMMA = 0x2c;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

function decode(input: string | Uint8Array): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      // `fatal` refuses bad UTF-8; the BOM is kept here and dropped below with the string's.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw tableReadError('malformed', 0);
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function limitsOf(limits: Partial<TableLimits> | undefined): TableLimits {
  return { ...CSV_DEFAULT_LIMITS, ...limits };
}

// The header's names: non-blank and distinct.
function checkHeader(cells: string[], maxColumns: number): string[] {
  if (cells.length > maxColumns) throw tableReadError('too_many_columns', 0);
  const seen = new Set<string>();
  for (const name of cells) {
    if (name.trim() === '' || seen.has(name)) throw tableReadError('malformed', 0);
    seen.add(name);
  }
  return cells;
}

/**
 * Reads a CSV file into its columns, rows and row count. Throws a `TableReadError` with
 * `malformed`, `too_many_rows` (at row `maxRows + 1`) or `too_many_columns`.
 */
export function parseCsv(input: string | Uint8Array, limits?: Partial<TableLimits>): TableRead<string> {
  const { maxRows, maxColumns, keepRows } = limitsOf(limits);
  const text = decode(input);
  const n = text.length;
  let columns: string[] | null = null;
  const rows: Array<Record<string, string>> = [];
  let rowCount = 0;
  let i = 0;

  while (i < n) {
    // An empty line is skipped.
    const first = text.charCodeAt(i);
    if (first === LF) {
      i += 1;
      continue;
    }
    if (first === CR) {
      i += text.charCodeAt(i + 1) === LF ? 2 : 1;
      continue;
    }

    const row = columns === null ? 0 : rowCount + 1;
    const cells: string[] = [];
    // A data row may hold at most the header's cells plus empty extras; the header itself at most
    // `maxColumns`. Past either bound the record is refused before more of it is held.
    const cellBound = columns === null ? maxColumns : Math.max(columns.length, maxColumns);
    for (;;) {
      let value: string;
      if (text.charCodeAt(i) === QUOTE) {
        let j = i + 1;
        value = '';
        for (;;) {
          const q = text.indexOf('"', j);
          if (q === -1) throw tableReadError('malformed', row);
          if (text.charCodeAt(q + 1) === QUOTE) {
            value += text.slice(j, q + 1);
            j = q + 2;
            continue;
          }
          value += text.slice(j, q);
          i = q + 1;
          break;
        }
        if (i < n) {
          const next = text.charCodeAt(i);
          if (next !== COMMA && next !== CR && next !== LF) throw tableReadError('malformed', row);
        }
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === COMMA || c === CR || c === LF) break;
          j += 1;
        }
        value = text.slice(i, j);
        i = j;
      }
      cells.push(value);
      if (cells.length > cellBound) {
        throw tableReadError(columns === null ? 'too_many_columns' : 'malformed', row);
      }
      if (i >= n) break;
      const c = text.charCodeAt(i);
      if (c === COMMA) {
        i += 1;
        continue;
      }
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      break;
    }

    if (columns === null) {
      columns = checkHeader(cells, maxColumns);
      continue;
    }
    if (cells.length > columns.length && cells.slice(columns.length).some((v) => v !== '')) {
      throw tableReadError('malformed', row);
    }
    rowCount += 1;
    if (rowCount > maxRows) throw tableReadError('too_many_rows', rowCount);
    if (rows.length < keepRows) {
      const header = columns;
      rows.push(Object.fromEntries(header.map((name, k) => [name, cells[k] ?? ''])));
    }
  }

  if (columns === null) throw tableReadError('malformed', 0);
  return { columns, rows, rowCount };
}
