// Section markers in document text are neutralised before the text reaches Gemma (D52.3; S4-006,
// behaviour 2). The prompt holds the document as data between our own <UNSTRUCTURED_DOCUMENT_CONTEXT>
// and </UNSTRUCTURED_DOCUMENT_CONTEXT>, and chat (S6) adds a <GRAPH_CONTEXT> section that is ground
// truth. A document that carries either marker itself could close its data section early or open a
// ground-truth one, so every marker in the text is replaced first.
//
// A marker is found in any case or spacing: `<`, an optional `/`, the name with its words joined by
// any run of spaces, `_` or dashes, then anything up to the next `>` (or nothing, when the `>` is
// missing). It is also found when written with look-alike characters (full-width letters or
// brackets, zero-width characters between the letters) or with `&lt;` / `&gt;`: matching runs on a
// folded copy of the text (each character in its compatibility form, lowercased, invisible format
// characters dropped), and the matched stretch of the original text is replaced.

/** What a neutralised marker becomes: no bracket and no marker name survive. */
export const NEUTRALISED_MARKER = '[section marker removed]';

const OPEN = String.raw`(?:<|&lt;|&#0*60;|&#x0*3c;)`;
const CLOSE = String.raw`(?:>|&gt;|&#0*62;|&#x0*3e;)`;
const GAP = String.raw`[\s_\p{Pd}]*`;
const NAME = String.raw`(?:unstructured${GAP}document${GAP}context|graph${GAP}context)`;

// On the folded text (lowercase). The tail allows attributes (`<graph_context source="x">`) and a
// missing `>`, bounded so one stray `<` can't swallow the rest of a chunk.
const MARKER = new RegExp(String.raw`${OPEN}\s*/?\s*${NAME}(?:[^<>]{0,200}?${CLOSE})?`, 'gu');

interface Folded {
  text: string;
  /** For each UTF-16 unit of the folded text, the start and end of the original character it came from. */
  from: number[];
  to: number[];
}

// Each character of the original in its compatibility form (NFKC), lowercased, with format
// characters (zero-width spaces and joiners, bidi marks) dropped; positions kept so a match maps
// back to the original text.
function fold(text: string): Folded {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const start = i;
    i += ch.length;
    if (/\p{Cf}/u.test(ch)) continue;
    const folded = ch.normalize('NFKC').toLowerCase();
    for (let k = 0; k < folded.length; k++) {
      from.push(start);
      to.push(i);
    }
    out.push(folded);
  }
  return { text: out.join(''), from, to };
}

/** The stretches of the original text that are section markers, in order, as [start, end). */
function markerSpans(text: string): [number, number][] {
  const folded = fold(text);
  const spans: [number, number][] = [];
  for (const m of folded.text.matchAll(MARKER)) {
    const first = m.index;
    const last = m.index + m[0].length - 1;
    const start = folded.from[first]!;
    const end = folded.to[last]!;
    const previous = spans[spans.length - 1];
    if (previous && start < previous[1]) previous[1] = Math.max(previous[1], end);
    else spans.push([start, end]);
  }
  return spans;
}

export interface NeutralisedText {
  text: string;
  /** How many markers were replaced. */
  neutralised: number;
}

/**
 * Replaces every <UNSTRUCTURED_DOCUMENT_CONTEXT>, </UNSTRUCTURED_DOCUMENT_CONTEXT>, <GRAPH_CONTEXT>
 * and </GRAPH_CONTEXT> in the text, in any case or spacing, with `NEUTRALISED_MARKER`. The rest of
 * the text is left exactly as it was.
 */
export function neutraliseSectionMarkers(text: string): NeutralisedText {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', neutralised: 0 };
  const spans = markerSpans(text);
  if (spans.length === 0) return { text, neutralised: 0 };
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + NEUTRALISED_MARKER;
    at = end;
  }
  out += text.slice(at);
  return { text: out, neutralised: spans.length };
}

/** How many section markers the text holds, found the same way `neutraliseSectionMarkers` finds them. */
export function countSectionMarkers(text: string): number {
  return typeof text === 'string' && text !== '' ? markerSpans(text).length : 0;
}
