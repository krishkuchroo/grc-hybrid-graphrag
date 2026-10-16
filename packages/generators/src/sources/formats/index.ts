// The binary document formats (D213 (8), D53): pure PDF and DOCX writers with Node's own modules
// only, so the generators' documents go through the same readers a customer's files do.
export type { DocumentText } from './document-text.js';
export { writeDocx } from './docx.js';
export { pdfKeepsWordsWhole, writePdf, wrapLines } from './pdf.js';
export { isWinAnsiText, textWidth, winAnsiBytes, winAnsiCode, type PdfFont } from './pdf-fonts.js';
export { writeZip, type ZipEntry } from './zip.js';
