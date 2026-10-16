// The PDF writer (D213 (8), D53): a document's title and paragraphs as a plain PDF 1.4 file, with
// Node's own modules only (`node:zlib` compresses the pages). A4 pages with 72-point margins; the
// title in Helvetica-Bold, the paragraphs in Helvetica (standard fonts, never embedded,
// WinAnsiEncoding), each line wrapped to the page at spaces and as many pages as the text needs.
// Every line is one text run at its own place on the page, so a PDF reader gives back each line's
// words in order, with a line break between lines; a sentence wrapped over two lines (or two pages)
// reads back whole, whitespace aside (`pdfKeepsWordsWhole`). Only a word wider than a whole line is
// cut, where the line is full, because a reader drops what lies off the page.
//
// Pure and repeatable: the file holds no date, no document ID and nothing else that changes between
// runs, so the same text always gives the same bytes. A character the standard fonts can't show
// (outside WinAnsiEncoding) is a RangeError, so a document is never written with text missing.
import { deflateSync } from 'node:zlib';
import type { DocumentText } from './document-text.js';
import { isWinAnsiText, textWidth, winAnsiBytes, type PdfFont } from './pdf-fonts.js';

/** A4, in points. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 72;
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

interface TextStyle {
  font: PdfFont;
  /** The font's name in each page's resources. */
  resource: 'F1' | 'F2';
  size: number;
  /** The height of one line. */
  leading: number;
  /** The space after the title or a paragraph. */
  gapAfter: number;
}

const TITLE: TextStyle = { font: 'Helvetica-Bold', resource: 'F2', size: 18, leading: 24, gapAfter: 12 };
const BODY: TextStyle = { font: 'Helvetica', resource: 'F1', size: 11, leading: 15, gapAfter: 6 };

interface PlacedLine {
  style: TextStyle;
  text: string;
  /** The baseline, in points from the bottom of the page. */
  y: number;
}

const WORD_SEPARATOR = /[ \t]+/;

/**
 * The text cut into lines no wider than `maxWidth` points, at spaces and tabs: a line break in the
 * text starts a new line, runs of spaces become one, and an empty line stays an empty line. A word
 * wider than a whole line is cut where the line is full.
 */
export function wrapLines(font: PdfFont, size: number, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    let current = '';
    for (const word of line.split(WORD_SEPARATOR)) {
      if (word === '') continue;
      const candidate = current === '' ? word : `${current} ${word}`;
      if (textWidth(font, size, candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      // The word starts the next line; one wider than the line fills lines until the rest fits.
      let piece = '';
      let width = 0;
      for (const char of word) {
        const charWidth = textWidth(font, size, char);
        if (piece !== '' && width + charWidth > maxWidth) {
          lines.push(piece);
          piece = '';
          width = 0;
        }
        piece += char;
        width += charWidth;
      }
      current = piece;
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Whether the text, as part of a paragraph, reads back whole from the PDF (whitespace aside): the
 * standard fonts show every character, and no word is wider than a line, so no word is cut.
 */
export function pdfKeepsWordsWhole(text: string): boolean {
  return text
    .split(/\r\n|\r|\n/)
    .every((line) =>
      line
        .split(WORD_SEPARATOR)
        .every((word) => isWinAnsiText(word) && textWidth(BODY.font, BODY.size, word) <= TEXT_WIDTH),
    );
}

/** Every line of the document on its page: the title first, then each paragraph. */
function layOut(doc: DocumentText): PlacedLine[][] {
  const pages: PlacedLine[][] = [[]];
  let top = PAGE_HEIGHT - MARGIN;
  const place = (style: TextStyle, text: string) => {
    let page = pages[pages.length - 1]!;
    if (top - style.leading < MARGIN && page.length > 0) {
      page = [];
      pages.push(page);
      top = PAGE_HEIGHT - MARGIN;
    }
    page.push({ style, text, y: top - style.size });
    top -= style.leading;
  };
  const block = (style: TextStyle, text: string) => {
    for (const line of wrapLines(style.font, style.size, text, TEXT_WIDTH)) place(style, line);
    top -= style.gapAfter;
  };
  if (doc.title.trim() !== '') block(TITLE, doc.title);
  for (const paragraph of doc.paragraphs) block(BODY, paragraph);
  return pages;
}

/** A PDF literal string's inside: printable ASCII as it is, `(`, `)` and `\` escaped, any other byte in octal. */
function pdfString(text: string): string {
  let out = '';
  for (const byte of winAnsiBytes(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

/** One page's drawing commands: each non-empty line placed at the left margin on its baseline. */
function pageContent(lines: readonly PlacedLine[]): string {
  const ops = ['BT'];
  let current: TextStyle | null = null;
  for (const line of lines) {
    if (line.text === '') continue;
    if (current !== line.style) {
      ops.push(`/${line.style.resource} ${line.style.size} Tf`);
      current = line.style;
    }
    ops.push(`1 0 0 1 ${MARGIN} ${line.y} Tm`, `(${pdfString(line.text)}) Tj`);
  }
  ops.push('ET');
  return `${ops.join('\n')}\n`;
}

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

function stream(content: string): Buffer {
  const data = deflateSync(latin1(content), { level: 9 });
  return Buffer.concat([
    latin1(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`),
    data,
    latin1('\nendstream'),
  ]);
}

/** The objects (object n at index n - 1) as a PDF file with its cross-reference table. */
function assemble(objects: readonly Buffer[]): Uint8Array {
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (chunk: Buffer) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  // The second line's bytes above 127 mark the file as binary for the tools that look.
  push(latin1('%PDF-1.4\n%âãÏÓ\n'));
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(latin1(`${i + 1} 0 obj\n`));
    push(body);
    push(latin1('\nendobj\n'));
  });
  const xref = offset;
  const entries = offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  push(
    latin1(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(chunks));
}

/** The document as a PDF file (see the top of the file). */
export function writePdf(doc: DocumentText): Uint8Array {
  const pages = layOut(doc);
  const font = (name: PdfFont) =>
    latin1(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
  // 1 catalog, 2 page tree, 3 and 4 the fonts, then each page and its content.
  const pageRef = (i: number) => 5 + 2 * i;
  const objects: Buffer[] = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`),
    font('Helvetica'),
    font('Helvetica-Bold'),
  ];
  pages.forEach((lines, i) => {
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`,
      ),
      stream(pageContent(lines)),
    );
  });
  return assemble(objects);
}
