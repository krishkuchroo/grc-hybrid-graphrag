// An asset list file read back into the flat rows a push batch carries (D11, D44, D47): what a
// connector does with an export before pushing it. CSV (RFC 4180: commas, CRLF or LF, quoted cells
// with `""` for a quote) and flat JSON (an array of objects whose values are strings, numbers,
// booleans or null). Pure: no network, filesystem or environment. Errors name only the file's place
// in the list, a row number or a column number, never a value (D163, D164).

/** A flat value, as the push API takes it. */
export type FlatValue = string | number | boolean | null;

/** One row of an asset list: its columns and their values. */
export type AssetRow = Record<string, FlatValue>;

/** The asset list formats a connector can push as rows. */
export type AssetListFormat = 'csv' | 'json';

export class AssetListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetListError';
  }
}

const BOM = '﻿';

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** The records of a CSV text, each a list of cells. A blank line is no record. */
export function parseCsvRecords(text: string): string[][] {
  const input = stripBom(text);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let cellStarted = false;
  let i = 0;

  const endCell = (): void => {
    record.push(cell);
    cell = '';
    cellStarted = false;
  };
  const endRecord = (): void => {
    endCell();
    // A line with nothing on it is not a record.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = input[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new AssetListError(`csv record ${records.length + 1}: text after a closing quote`);
        }
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endCell();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '"') throw new AssetListError(`csv record ${records.length + 1}: a quote inside an unquoted cell`);
    cell += ch;
    cellStarted = true;
    i += 1;
  }
  if (quoted) throw new AssetListError(`csv record ${records.length + 1}: a quoted cell is never closed`);
  if (cellStarted || cell !== '' || record.length > 0) endRecord();
  return records;
}

/** A CSV asset list as rows keyed by its header. A row shorter than the header gets '' for the rest. */
export function csvRows(text: string): AssetRow[] {
  const [header, ...records] = parseCsvRecords(text);
  if (!header) return [];
  const seen = new Set<string>();
  header.forEach((column, i) => {
    if (column.trim() === '') throw new AssetListError(`csv header: column ${i + 1} has no name`);
    if (seen.has(column)) throw new AssetListError(`csv header: column ${i + 1} repeats an earlier name`);
    seen.add(column);
  });
  return records.map((cells, r) => {
    if (cells.length > header.length) {
      throw new AssetListError(`csv row ${r + 1}: more cells than the header has columns`);
    }
    const row: AssetRow = {};
    header.forEach((column, i) => {
      row[column] = cells[i] ?? '';
    });
    return row;
  });
}

function isFlatValue(value: unknown): value is FlatValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A flat JSON asset list (an array of flat objects) as rows. */
export function jsonRows(text: string): AssetRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    throw new AssetListError('json: the file is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new AssetListError('json: the file is not an array of rows');
  return parsed.map((item: unknown, r) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AssetListError(`json row ${r + 1}: not an object`);
    }
    const row: AssetRow = {};
    for (const [column, value] of Object.entries(item as Record<string, unknown>)) {
      if (column.trim() === '') throw new AssetListError(`json row ${r + 1}: a column has no name`);
      if (!isFlatValue(value)) {
        throw new AssetListError(`json row ${r + 1}: a value is not a string, number, boolean or null`);
      }
      row[column] = value;
    }
    return row;
  });
}

/** An asset list file's rows, by its format. */
export function assetRows(format: string, body: string): AssetRow[] {
  if (format === 'csv') return csvRows(body);
  if (format === 'json') return jsonRows(body);
  throw new AssetListError(`an asset list in ${format} can't be pushed as rows (csv or json only)`);
}
