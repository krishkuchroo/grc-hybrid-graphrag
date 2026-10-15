// What an upload's bytes are, checked by content (D53; S3 shared notes, "Upload safety"). The API
// never opens a file: this reads only
//   - the first bytes (`SNIFF_HEAD_BYTES`), for the PDF and zip signatures and JSON's first character;
//   - for a zip, its end-of-central-directory record and the central directory's entry names, never
//     an entry's contents (nothing is extracted or inflated);
//   - for anything else, whether the bytes are valid UTF-8 with no NUL byte (a byte check, not a
//     parse).
// `detectFileFormat` (@grc/shared) then decides, together with the file name's extension.
import { isUtf8 } from 'node:buffer';
import { detectFileFormat, type DetectFileFormatResult } from '@grc/shared';

/** How many leading bytes the checks look at. */
export const SNIFF_HEAD_BYTES = 4096;

/** At most this many central-directory entries are read; a zip with more is refused as a zip. */
export const MAX_ZIP_ENTRIES = 10_000;

export interface Sniffed {
  /** The first bytes of the file (at most `SNIFF_HEAD_BYTES`). */
  head: Uint8Array;
  /** A zip's entry names from its central directory, or undefined when the file isn't a zip. An
   * unreadable or ZIP64 directory gives an empty list, so the file is refused as a zip. */
  zipEntries?: string[];
  /** Whether the whole file is valid UTF-8 with no NUL byte (false for PDFs and zips, unchecked). */
  isUtf8Text: boolean;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const UTF8_NAME_FLAG = 0x0800;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The offset of the end-of-central-directory record: the last signature whose comment length
 * reaches exactly the end of the file. -1 when there is none. */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const dv = view(bytes);
  const lowest = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = bytes.length - EOCD_SIZE; at >= lowest; at--) {
    if (dv.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const commentLength = dv.getUint16(at + 20, true);
    if (at + EOCD_SIZE + commentLength === bytes.length) return at;
  }
  return -1;
}

/**
 * The entry names listed in a zip's central directory. Only the directory's own headers are read;
 * no entry is opened. Anything malformed, or a ZIP64 directory, gives an empty list (fail safe:
 * the file is then refused as a zip).
 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  if (bytes.length < EOCD_SIZE) return [];
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) return [];
  const dv = view(bytes);
  const total = dv.getUint16(eocd + 10, true);
  const size = dv.getUint32(eocd + 12, true);
  const start = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || size === 0xffffffff || start === 0xffffffff) return []; // ZIP64
  if (total > MAX_ZIP_ENTRIES || start + size > eocd) return [];

  const names: string[] = [];
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  const end = start + size;
  let at = start;
  for (let i = 0; i < total; i++) {
    if (at + CENTRAL_HEADER_SIZE > end || dv.getUint32(at, true) !== CENTRAL_SIGNATURE) return [];
    const flags = dv.getUint16(at + 8, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const nameStart = at + CENTRAL_HEADER_SIZE;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > end) return [];
    const raw = bytes.subarray(nameStart, nameStart + nameLength);
    names.push((flags & UTF8_NAME_FLAG) !== 0 ? utf8.decode(raw) : latin1.decode(raw));
    at = next;
  }
  return names;
}

/** Whether the bytes are valid UTF-8 text with no NUL byte. */
export function isUtf8Text(bytes: Uint8Array): boolean {
  return bytes.indexOf(0) < 0 && isUtf8(bytes);
}

/** Reads what `detectFileFormat` needs from a file's bytes, and nothing more. */
export function sniff(bytes: Uint8Array): Sniffed {
  const head = bytes.subarray(0, SNIFF_HEAD_BYTES);
  if (startsWith(head, ZIP_MAGIC)) return { head, zipEntries: zipEntryNames(bytes), isUtf8Text: false };
  if (startsWith(head, PDF_MAGIC)) return { head, isUtf8Text: false };
  return { head, isUtf8Text: isUtf8Text(bytes) };
}

/** The file's format by its content and name, or why it's refused. */
export function sniffFileFormat(fileName: string, bytes: Uint8Array): DetectFileFormatResult {
  return detectFileFormat({ fileName, ...sniff(bytes) });
}
