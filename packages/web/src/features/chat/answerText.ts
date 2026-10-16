// Gemma's answer, read for the panel (S6-007 behaviour 5). The answer prompt asks for plain text, a
// few sentences or a short list (chat-answer-v1), so the panel shows paragraphs, bulleted and
// numbered lists and **bold**; everything else is shown as written, never as HTML.
// Citations are read with the API's own rule (packages/api/src/chat/citations.ts): square brackets
// holding one or more source numbers, `[1]`, `[1, 3]`, `[2; 4]`, `[1 and 2]`, a range `[1-3]`, or
// with the word "source" (`[Source 2]`); brackets side by side (`[1][2]`) each count. Anything else
// in brackets is plain text. Which numbers become chips is the message's own citation list, the
// sources the API kept (D45.6).
// Pure: no I/O, no clock, no randomness.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  /** A citation: the bracket as written and the numbers it cites, in order, each once. */
  | { type: 'cite'; raw: string; numbers: number[] };

export type Block = { type: 'paragraph'; lines: Inline[][] } | { type: 'list'; ordered: boolean; items: Inline[][] };

const BRACKET = /\[([^[\]\n]{1,80})\]/g;
const SEPARATOR = /\s*(?:,|;|&|\band\b)\s*/i;
const ITEM = /^(?:sources?\s*)?(\d{1,6})(?:\s*[-–—]\s*(?:sources?\s*)?(\d{1,6}))?$/i;
/** A longer range counts its two ends only, as the API reads it. */
const MAX_RANGE = 50;

const BOLD = /\*\*([^*\n]+?)\*\*/g;
const LIST_ITEM = /^\s*(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const CONTINUATION = /^\s{2,}\S/;

/** The numbers one bracket's text cites, in order and each once, or null when it isn't a citation. */
export function bracketNumbers(inner: string): number[] | null {
  const parts = inner.trim().split(SEPARATOR);
  const numbers: number[] = [];
  for (const part of parts) {
    const match = ITEM.exec(part.trim());
    if (!match) return null;
    const low = Number(match[1]);
    const high = match[2] === undefined ? low : Number(match[2]);
    if (high < low || high - low > MAX_RANGE) {
      numbers.push(low, high);
      continue;
    }
    for (let n = low; n <= high; n++) numbers.push(n);
  }
  return [...new Set(numbers)];
}

function boldPieces(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const match of text.matchAll(BOLD)) {
    const start = match.index ?? 0;
    if (start > at) out.push({ type: 'text', text: text.slice(at, start) });
    out.push({ type: 'strong', text: match[1] ?? '' });
    at = start + match[0].length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/** One line of the answer as text, bold and citations. */
export function inlinePieces(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const match of line.matchAll(BRACKET)) {
    const numbers = bracketNumbers(match[1] ?? '');
    if (numbers === null) continue;
    const start = match.index ?? 0;
    if (start > at) out.push(...boldPieces(line.slice(at, start)));
    out.push({ type: 'cite', raw: match[0], numbers });
    at = start + match[0].length;
  }
  if (at < line.length) out.push(...boldPieces(line.slice(at)));
  return out;
}

/** The answer as paragraphs and lists. A blank line ends a paragraph; consecutive `- `, `* `, `• `
 * or `1. ` lines make a list, and an indented line carries on its item. */
export function answerBlocks(answer: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const endParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', lines: paragraph.map(inlinePieces) });
    paragraph = [];
  };
  const endList = (): void => {
    if (list !== null && list.items.length > 0) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(inlinePieces) });
    }
    list = null;
  };

  const text = typeof answer === 'string' ? answer.replace(/\r\n?/g, '\n') : '';
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      endParagraph();
      endList();
      continue;
    }
    const item = LIST_ITEM.exec(raw);
    if (item) {
      endParagraph();
      const ordered = item[2] !== undefined;
      if (list === null || list.ordered !== ordered) {
        endList();
        list = { ordered, items: [] };
      }
      list.items.push((item[3] ?? '').trim());
      continue;
    }
    const current = list as { ordered: boolean; items: string[] } | null;
    if (current !== null && CONTINUATION.test(raw) && current.items.length > 0) {
      const last = current.items.length - 1;
      current.items[last] = `${current.items[last] ?? ''} ${raw.trim()}`;
      continue;
    }
    endList();
    const heading = HEADING.exec(raw);
    paragraph.push(heading ? `**${(heading[1] ?? '').replace(/\*\*/g, '')}**` : raw.trim());
  }
  endParagraph();
  endList();
  return blocks;
}

/** The source numbers an answer cites, in the order first cited, each once. */
export function citedNumbersInOrder(answer: string): number[] {
  const seen = new Set<number>();
  for (const block of answerBlocks(answer)) {
    const lines = block.type === 'paragraph' ? block.lines : block.items;
    for (const line of lines) {
      for (const piece of line) if (piece.type === 'cite') for (const n of piece.numbers) seen.add(n);
    }
  }
  return [...seen];
}
