// The DOCX writer (D213 (8), D53): a document's title and paragraphs as a minimal Word document, with
// Node's own modules only (see zip.ts). Three parts: the content types, the package relationships
// and the document part. The title is a heading (style Heading1, set in bold at 16 points so it
// reads as one without a styles part), then one paragraph per paragraph; a tab is a tab, and each
// line of a paragraph that holds line breaks is a Word paragraph of its own, with no space between
// them (a reader of Word's raw text drops a plain line break, which would join the two lines' words).
// A4 pages with 1-inch margins.
//
// Pure and repeatable: no document properties, no dates, no IDs; the zip entries carry a fixed
// time, so the same text always gives the same bytes. A character XML can't hold (a control
// character other than tab and line breaks, a lone surrogate, U+FFFE or U+FFFF) is a RangeError, so a
// document is never written with text missing.
import type { DocumentText } from './document-text.js';
import { writeZip } from './zip.js';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const PACKAGE_RELATIONSHIPS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="word/document.xml"/>' +
  '</Relationships>';

/** A4 with 1-inch margins, in twentieths of a point. */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
  '</w:sectPr>';

// XML 1.0's characters: tab, line feed, carriage return, and U+0020 up, without the surrogates
// (a lone one fails the well-formed check), U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

function escapeXml(text: string): string {
  if (!text.isWellFormed() || NOT_XML.test(text)) {
    throw new RangeError('the text has a character a Word document cannot hold');
  }
  return text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const LINE_BREAK = /\r\n|\r|\n/;

/** A run's inside: one line's text, with each tab a `<w:tab/>`. */
function runContent(line: string): string {
  return line
    .split('\t')
    .map((part) => (part === '' ? '' : `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`))
    .join('<w:tab/>');
}

/** The text as Word paragraphs, one per line: the space after only below the last line. */
function paragraphs(text: string, properties: string, runProperties: string, spaceAfter: number): string {
  const lines = text.split(LINE_BREAK);
  return lines
    .map((line, i) => {
      const after = i === lines.length - 1 ? spaceAfter : 0;
      return (
        `<w:p><w:pPr>${properties}<w:spacing w:after="${after}"/></w:pPr>` +
        `<w:r>${runProperties}${runContent(line)}</w:r></w:p>`
      );
    })
    .join('');
}

function heading(text: string): string {
  return paragraphs(text, '<w:pStyle w:val="Heading1"/>', '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>', 240);
}

function paragraph(text: string): string {
  return paragraphs(text, '', '', 120);
}

function documentPart(doc: DocumentText): string {
  const body = [...(doc.title.trim() === '' ? [] : [heading(doc.title)]), ...doc.paragraphs.map(paragraph)].join('');
  return (
    `${XML_DECLARATION}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}${SECTION}</w:body></w:document>`
  );
}

const utf8 = new TextEncoder();

/** The document as a DOCX file (see the top of the file). */
export function writeDocx(doc: DocumentText): Uint8Array {
  return writeZip([
    { name: '[Content_Types].xml', data: utf8.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: utf8.encode(PACKAGE_RELATIONSHIPS) },
    { name: 'word/document.xml', data: utf8.encode(documentPart(doc)) },
  ]);
}
