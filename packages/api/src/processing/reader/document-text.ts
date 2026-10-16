// A document's text (S4-004; D33, D53): what the reader cuts into chunks. Only the worker runs this,
// inside the file sandbox's own process (src/intake/imports/file-sandbox.ts, `runInProcessSandbox`:
// a Worker in a child process whose whole memory is limited, so the buffers unpdf and mammoth
// decompress into count as well as the heap; a time limit, an empty environment, its output thrown
// away), so the API program never opens a file and a file too big once decompressed can't take the
// worker down. Like the asset-list parsers it imports no module of ours (only types, which are
// erased), so the sandbox's Worker loads it by itself.
//
// - PDF: the text of every page through unpdf (PDF.js), pages joined with a line break. No fonts
//   are loaded and nothing but the text is read (embedded files, scripts and images are ignored). A PDF that needs a password, or is encrypted at all, is `unreadable`.
// - DOCX: the raw text through mammoth (paragraphs end with a blank line). Macros, embedded objects
//   and images are never read, and mammoth's external file access stays off.
// - TXT: the bytes as UTF-8 (a leading BOM dropped).
// - JSON: readable lines, one per value: its key path (nested keys joined with `.`, list items
//   numbered from 1), `: `, then the value (`null`, `true`, numbers and strings as written). A value
//   at the top level is a line of its own. Empty lists and objects give no line.
// Then line endings are made `\n`, NUL characters (which Postgres can't store) are dropped and a
// lone surrogate becomes U+FFFD, so every chunk's text is an exact slice of what is returned.
//
// A file that can't be read throws an error with the code `unreadable` (the sandbox passes it on);
// an error message never holds anything from the file. A RangeError (a string or buffer that can't
// grow) is passed on as it is, so the sandbox reports it as `too_much_memory`.
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { ReadableFormat } from './readable-kinds.js';

/** The code a file that can't be read fails with. */
export const UNREADABLE = 'unreadable';

interface CodedError extends Error {
  code: string;
}

function unreadable(): CodedError {
  const err = new Error('The file could not be read (unreadable).') as CodedError;
  err.name = 'DocumentTextError';
  err.code = UNREADABLE;
  return err;
}

// A RangeError goes on as it is (the sandbox's `too_much_memory`); anything else is `unreadable`.
function refuse(err: unknown): never {
  if (err instanceof RangeError) throw err;
  throw unreadable();
}

function utf8(input: Uint8Array): string {
  try {
    // A leading BOM is dropped by the decoder (ignoreBOM is false).
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (err) {
    refuse(err);
  }
}

async function pdfText(input: Uint8Array): Promise<string> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(input, {
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      verbosity: 0,
    });
  } catch (err) {
    refuse(err);
  }
  try {
    const { info } = await pdf.getMetadata();
    // PDF.js names the encryption filter of an encrypted file, even one with an empty password.
    const filter = (info as { EncryptFilterName?: unknown } | null)?.EncryptFilterName;
    if (typeof filter === 'string' && filter !== '') throw unreadable();
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch (err) {
    refuse(err);
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

async function docxText(input: Uint8Array): Promise<string> {
  try {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(input.buffer, input.byteOffset, input.byteLength),
    });
    return result.value;
  } catch (err) {
    refuse(err);
  }
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * A parsed JSON value as readable lines (see the top of the file). Walks the value with its own
 * stack, so a deeply nested file can't overflow the call stack.
 */
export function jsonToLines(value: unknown): string {
  const lines: string[] = [];
  const stack: Array<{ path: string; value: unknown }> = [{ path: '', value }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (Array.isArray(item.value)) {
      for (let i = item.value.length - 1; i >= 0; i -= 1) {
        stack.push({ path: joinPath(item.path, String(i + 1)), value: item.value[i] });
      }
    } else if (item.value !== null && typeof item.value === 'object') {
      const entries = Object.entries(item.value as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, v] = entries[i]!;
        stack.push({ path: joinPath(item.path, key), value: v });
      }
    } else {
      const text = item.value === null ? 'null' : String(item.value);
      lines.push(item.path === '' ? text : `${item.path}: ${text}`);
    }
  }
  return lines.join('\n');
}

function jsonText(input: Uint8Array): string {
  const text = utf8(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    refuse(err);
  }
  return jsonToLines(parsed);
}

/** Line endings made `\n`, NUL characters dropped, lone surrogates made U+FFFD. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').toWellFormed();
}

/**
 * The text of a document's bytes in its format (see the top of the file). Throws an error with
 * the code `unreadable` for a file that can't be read.
 */
export async function readDocumentText(input: Uint8Array, format: ReadableFormat): Promise<string> {
  let text: string;
  switch (format) {
    case 'pdf':
      text = await pdfText(input);
      break;
    case 'docx':
      text = await docxText(input);
      break;
    case 'txt':
      text = utf8(input);
      break;
    case 'json':
      text = jsonText(input);
      break;
    default:
      throw unreadable();
  }
  return cleanText(text);
}
