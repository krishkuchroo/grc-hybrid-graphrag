/**
 * What the PDF and DOCX writers lay out: the document's title and the paragraphs below it, in order.
 * A paragraph's words are separated by spaces; a line break inside a paragraph starts a new line.
 */
export interface DocumentText {
  title: string;
  paragraphs: readonly string[];
}
