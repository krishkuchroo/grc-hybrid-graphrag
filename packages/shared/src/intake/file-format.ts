// The five upload formats, checked by content (D53, D45.7 fail safe; S3 shared notes, "Upload safety").
// Pure: the caller passes the first bytes, the zip's entry names and whether the whole file is UTF-8
// with no NUL byte. Any zip that isn't a DOCX named `.docx` is refused.

export const FILE_FORMATS = ['pdf', 'docx', 'csv', 'json', 'txt'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const FORMAT_CONTENT_TYPES: Readonly<Record<FileFormat, string>> = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
});

export interface DetectFileFormatInput {
  fileName: string;
  head: Uint8Array;
  zipEntries?: readonly string[];
  isUtf8Text: boolean;
}

export type DetectFileFormatResult =
  { ok: true; format: FileFormat } | { ok: false; reason: 'zip' | 'unknown_type' | 'extension_mismatch' | 'empty' };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const DOCX_ENTRIES = ['[Content_Types].xml', 'word/document.xml'];
const WHITE_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return head.length >= magic.length && magic.every((b, i) => head[i] === b);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function isFileFormat(v: string): v is FileFormat {
  return (FILE_FORMATS as readonly string[]).includes(v);
}

function startsLikeJson(head: Uint8Array): boolean {
  for (const b of head) {
    if (WHITE_SPACE.has(b)) continue;
    return b === 0x7b || b === 0x5b; // { or [
  }
  return false;
}

export function detectFileFormat(input: DetectFileFormatInput): DetectFileFormatResult {
  const { fileName, head, zipEntries, isUtf8Text } = input;
  if (head.length === 0) return { ok: false, reason: 'empty' };
  const ext = extensionOf(fileName);

  if (startsWith(head, ZIP_MAGIC)) {
    const entries = zipEntries ?? [];
    if (ext === 'docx' && DOCX_ENTRIES.every((e) => entries.includes(e))) return { ok: true, format: 'docx' };
    return { ok: false, reason: 'zip' };
  }

  if (!isFileFormat(ext)) return { ok: false, reason: 'unknown_type' };

  const isPdf = startsWith(head, PDF_MAGIC);
  const isText = isUtf8Text && !isPdf;
  let matches: boolean;
  switch (ext) {
    case 'pdf':
      matches = isPdf;
      break;
    case 'docx':
      matches = false; // a DOCX is always a zip
      break;
    case 'json':
      matches = isText && startsLikeJson(head);
      break;
    default:
      matches = isText;
  }
  return matches ? { ok: true, format: ext } : { ok: false, reason: 'extension_mismatch' };
}
