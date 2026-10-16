// The answer's citations (S6-006 behaviour 2.6; S6 shared notes, "Answer"). Gemma cites by source
// number, `[1]`, `[2]`…, and our code keeps only the numbers that match a source the answer was
// given; any other number is ignored (the AI proposes, our code decides, D45.6).
// - A citation is a pair of square brackets holding one or more source numbers: `[1]`, `[1, 3]`,
//   `[2; 4]`, `[1 and 2]`, a range `[1-3]`, or with the word "source" (`[Source 2]`). Brackets side
//   by side (`[1][2]`) count each. Anything else in brackets is not a citation.
// - The numbers are kept ascending, each once.
// Pure: no I/O, no clock, no randomness.
import type { AnswerSource, Citation, StoredCitation } from '@grc/shared';

export interface CitedNumbers {
  /** The cited numbers that match a source, ascending, each once. */
  valid: number[];
  /** The cited numbers that match no source, ascending, each once. */
  ignored: number[];
}

/** A range longer than this counts its two ends only, so `[1-999999]` can't cite everything. */
const MAX_RANGE = 50;

const BRACKET = /\[([^[\]\n]{1,80})\]/g;
const SEPARATOR = /\s*(?:,|;|&|\band\b)\s*/i;
const ITEM = /^(?:sources?\s*)?(\d{1,6})(?:\s*[-–—]\s*(?:sources?\s*)?(\d{1,6}))?$/i;

/** The numbers one bracket's text cites, or null when it isn't a citation. */
function bracketNumbers(inner: string): number[] | null {
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
  return numbers;
}

/** Every number the answer cites, in the order first cited, each once. */
export function citedNumbersInOrder(answer: string): number[] {
  if (typeof answer !== 'string' || answer === '') return [];
  const seen = new Set<number>();
  for (const match of answer.matchAll(BRACKET)) {
    const numbers = bracketNumbers(match[1] ?? '');
    if (numbers === null) continue;
    for (const n of numbers) seen.add(n);
  }
  return [...seen];
}

/** The numbers the answer cites, split into those that match one of the sources and the rest. */
export function citedNumbers(answer: string, sources: readonly Pick<AnswerSource, 'number'>[]): CitedNumbers {
  const known = new Set(sources.map((s) => s.number));
  const valid: number[] = [];
  const ignored: number[] = [];
  for (const n of citedNumbersInOrder(answer)) (known.has(n) ? valid : ignored).push(n);
  const ascending = (a: number, b: number): number => a - b;
  return { valid: valid.sort(ascending), ignored: ignored.sort(ascending) };
}

/** The sources the answer cites, by ascending number. */
export function citedSources(answer: string, sources: readonly AnswerSource[]): AnswerSource[] {
  const byNumber = new Map(sources.map((s) => [s.number, s]));
  return citedNumbers(answer, sources)
    .valid.map((n) => byNumber.get(n))
    .filter((s): s is AnswerSource => s !== undefined);
}

/** What is stored for a cited source: only what's needed to read it again (S6-001). */
export function storedCitation(source: AnswerSource): StoredCitation {
  if (source.type === 'record') {
    return {
      number: source.number,
      type: 'record',
      recordId: source.record.id,
      recordNumber: source.record.number,
      recordKind: source.record.kind,
    };
  }
  return {
    number: source.number,
    type: 'passage',
    chunkId: source.passage.chunkId,
    documentId: source.passage.documentId,
  };
}

/** A cited source as a message shows it, to the person who has just been given it. */
export function shownCitation(source: AnswerSource): Citation {
  if (source.type === 'record') {
    const { id, number, name, kind } = source.record;
    return { number: source.number, type: 'record', record: { id, number, name, kind } };
  }
  const { chunkId, documentId, documentName, documentKind, position, text } = source.passage;
  return {
    number: source.number,
    type: 'passage',
    passage: { chunkId, documentId, documentName, documentKind, position, text },
  };
}
