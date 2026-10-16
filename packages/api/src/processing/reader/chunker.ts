// Cutting a document's text into chunks (S4-004; D71): windows of at most 500 bge-m3 tokens, each
// starting 50 tokens before the previous one ended. Every chunk's text is the exact slice
// `text.slice(startOffset, endOffset)` of the document's text, and its token count is the count
// bge-m3's tokenizer gives that slice.
//
// How:
// 1. The text is split into units: each run of non-space characters (a word), with its offsets
//    and its token count. bge-m3's pre-tokenizer splits on spaces and starts every word with `▁`,
//    so a slice's count is the sum of its words' counts. A word over 32 tokens (a long code, a
//    run of text with no spaces) is split in halves, at character boundaries, until each part is
//    at most 32 tokens; a part's count is then at least what it adds to a slice, so a window is
//    never over by the split. Units that make no token are dropped.
// 2. A window takes as many units as fit in 500 tokens. Its slice runs from its first unit's start
//    to its last unit's end, so a chunk never starts or ends with spaces. The slice is counted
//    again as a whole; were it ever over 500, units come off the end until it fits.
// 3. The next window starts at the unit that puts the overlap with the previous window closest to
//    50 tokens (the larger on a tie), always after the previous window's start; the last window
//    ends at the last unit.
// The units are read as the windows need them, and the ones before the current window's start are
// let go (D53): besides the text and the chunks themselves (about 100 bytes each, their texts
// slices of the one text), the memory used is that of one window's units (at most `maxTokens` + 1),
// whatever the length of the text, so a long text of short words can't take the worker past its
// memory. Repeat words are counted once (a cache bounded in entries and in characters), and the
// work stops for the event loop every so often, so a long document doesn't hold up the worker's
// other jobs.
import { CHUNK_MAX_TOKENS, CHUNK_OVERLAP_TOKENS } from '@grc/shared';
import type { TokenCounter } from './tokenizer.js';

/** One chunk of a document's text. */
export interface TextChunk {
  /** The chunk's place in its document, from 0. */
  position: number;
  /** `text.slice(startOffset, endOffset)` of the document's text. */
  text: string;
  startOffset: number;
  endOffset: number;
  /** bge-m3's token count of `text`, from 1 to `maxTokens`. */
  tokenCount: number;
}

export interface ChunkOptions {
  /** At most this many tokens in a chunk (500, D71). */
  maxTokens?: number;
  /** Each chunk starts this many tokens before the previous one ended (50, D71). */
  overlapTokens?: number;
}

/** A word over this many tokens (or over `maxTokens`, if lower) is split into parts of at most that many. */
export const MAX_UNIT_TOKENS = 32;

// A part longer than this many UTF-16 units is split before it is counted at all (the tokenizer
// library can't count a very long run of text in one go).
const MAX_COUNTED_LENGTH = 1024;
// Stop for the event loop after this many steps (a word found, or a part counted).
const YIELD_EVERY = 2000;
// The most distinct words kept in the count cache, and the most characters they may hold together.
const CACHE_LIMIT = 100_000;
const CACHE_CHARACTER_LIMIT = 4_000_000;

interface Unit {
  start: number;
  end: number;
  tokens: number;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The middle of [start, end), for a range of 2 or more: at a character boundary (never between a
// surrogate pair's halves) when that leaves both parts non-empty.
function middle(text: string, start: number, end: number): number {
  const mid = start + Math.floor((end - start) / 2);
  const code = text.charCodeAt(mid);
  if (code < 0xdc00 || code > 0xdfff) return mid;
  if (mid - 1 > start) return mid - 1;
  if (mid + 1 < end) return mid + 1;
  return mid;
}

class UnitCounter {
  private readonly cache = new Map<string, number>();
  private cachedCharacters = 0;

  constructor(private readonly counter: TokenCounter) {}

  count(piece: string): number {
    const cached = this.cache.get(piece);
    if (cached !== undefined) return cached;
    const n = this.counter.count(piece);
    if (this.cache.size >= CACHE_LIMIT || this.cachedCharacters + piece.length > CACHE_CHARACTER_LIMIT) {
      this.cache.clear();
      this.cachedCharacters = 0;
    }
    this.cache.set(piece, n);
    this.cachedCharacters += piece.length;
    return n;
  }
}

/**
 * The units of a text (see the top of the file), in order, each at most `cap` tokens, read only as
 * far as asked. Unit `i` is the text's i-th unit, counted from 0; the ones dropped are gone.
 */
class UnitReader {
  // The spaces before the next word, and the word: tested in place (sticky, from `lastIndex`), so
  // finding a word makes no match object.
  private readonly spaces = /\s*/y;
  private readonly word = /\S+/y;
  // Where the next word is looked for from.
  private at = 0;
  // The parts of the current word still to count, the next one last.
  private readonly parts: Array<[number, number]> = [];
  // The units read and not dropped: `units[k]` is unit `base + k`.
  private readonly units: Unit[] = [];
  private base = 0;
  private steps = 0;
  private done = false;

  constructor(
    private readonly text: string,
    private readonly cap: number,
    private readonly counter: UnitCounter,
  ) {}

  /** Unit `i`, or undefined when the text has no unit `i` or it hasn't been read yet. */
  get(i: number): Unit | undefined {
    return i >= this.base ? this.units[i - this.base] : undefined;
  }

  /**
   * Reads on until the units from `from` on hold more than `tokens` tokens together, or the text
   * has no more units. Unit `from` must have been read already, or be the next one to read.
   */
  async fill(from: number, tokens: number): Promise<void> {
    let sum = 0;
    for (let k = Math.max(0, from - this.base); k < this.units.length; k += 1) sum += this.units[k]!.tokens;
    while (sum <= tokens && !this.done) {
      const unit = this.step();
      if (unit !== null) {
        this.units.push(unit);
        sum += unit.tokens;
      }
      this.steps += 1;
      if (this.steps % YIELD_EVERY === 0) await yieldToLoop();
    }
  }

  /** Lets go of the units before `i`. */
  drop(i: number): void {
    const n = Math.min(i - this.base, this.units.length);
    if (n <= 0) return;
    this.units.splice(0, n);
    this.base += n;
  }

  // One step: finds the next word, or counts one part of the current word (splitting it while it
  // is over `cap` tokens or too long to count). Answers the unit it made, if any.
  private step(): Unit | null {
    const part = this.parts.pop();
    if (part === undefined) {
      this.spaces.lastIndex = this.at;
      const start = this.spaces.test(this.text) ? this.spaces.lastIndex : this.text.length;
      this.word.lastIndex = start;
      if (this.word.test(this.text)) {
        this.at = this.word.lastIndex;
        this.parts.push([start, this.at]);
      } else {
        this.done = true;
      }
      return null;
    }
    const [s, e] = part;
    const text = this.text;
    const single = e - s === 1 || (e - s === 2 && text.charCodeAt(s) >= 0xd800 && text.charCodeAt(s) <= 0xdbff);
    if (e - s > MAX_COUNTED_LENGTH && !single) {
      const mid = middle(text, s, e);
      this.parts.push([mid, e], [s, mid]);
      return null;
    }
    const tokens = this.counter.count(text.slice(s, e));
    if (tokens > this.cap && !single) {
      const mid = middle(text, s, e);
      this.parts.push([mid, e], [s, mid]);
      return null;
    }
    return tokens > 0 ? { start: s, end: e, tokens } : null;
  }
}

/**
 * Cuts `text` into chunks (see the top of the file). A text with no tokens gives no chunks.
 * Throws only if a single unit is over `maxTokens`, which a 32-token unit can't be.
 */
export async function chunkText(text: string, counter: TokenCounter, opts: ChunkOptions = {}): Promise<TextChunk[]> {
  const maxTokens = opts.maxTokens ?? CHUNK_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? CHUNK_OVERLAP_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1)
    throw new Error('chunkText: maxTokens must be a whole number from 1');
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('chunkText: overlapTokens must be a whole number below maxTokens');
  }
  const units = new UnitReader(text, Math.min(MAX_UNIT_TOKENS, maxTokens), new UnitCounter(counter));
  const chunks: TextChunk[] = [];
  let first = 0;
  let prevLast = -1;

  for (;;) {
    // Every unit this window can take, and the one after it (when there is one).
    await units.fill(first, maxTokens);
    const firstUnit = units.get(first);
    if (firstUnit === undefined) break;

    // As many units as fit, by their counts.
    let last = first;
    let sum = firstUnit.tokens;
    for (let u = units.get(last + 1); u !== undefined && sum + u.tokens <= maxTokens; u = units.get(last + 1)) {
      last += 1;
      sum += u.tokens;
    }
    // The slice counted as a whole; units come off the end while it is over (never back to the
    // previous window's end, so every window adds something).
    let lastUnit = units.get(last)!;
    let slice = text.slice(firstUnit.start, lastUnit.end);
    let tokenCount = counter.count(slice);
    while (tokenCount > maxTokens && last > Math.max(first, prevLast + 1)) {
      last -= 1;
      lastUnit = units.get(last)!;
      slice = text.slice(firstUnit.start, lastUnit.end);
      tokenCount = counter.count(slice);
    }
    if (tokenCount > maxTokens) {
      if (first <= prevLast) {
        // The overlap left no room: this window starts after the previous one instead.
        first = prevLast + 1;
        units.drop(first);
        continue;
      }
      throw new Error('chunkText: a unit is over the token limit');
    }
    if (tokenCount > 0) {
      chunks.push({
        position: chunks.length,
        text: slice,
        startOffset: firstUnit.start,
        endOffset: lastUnit.end,
        tokenCount,
      });
    }
    // The units read run past this window unless the text has none left.
    if (units.get(last + 1) === undefined) break;

    // The next start: the overlap closest to `overlapTokens` (the larger on a tie), after `first`.
    let next = last + 1;
    if (overlapTokens > 0) {
      let overlap = 0;
      let bestStart = last + 1;
      let bestGap = overlapTokens;
      for (let k = last; k > first; k -= 1) {
        overlap += units.get(k)!.tokens;
        const gap = Math.abs(overlap - overlapTokens);
        if (gap <= bestGap) {
          bestGap = gap;
          bestStart = k;
        }
        if (overlap >= overlapTokens) break;
      }
      next = bestStart;
    }
    prevLast = last;
    first = next;
    units.drop(first);
    await yieldToLoop();
  }
  return chunks;
}
