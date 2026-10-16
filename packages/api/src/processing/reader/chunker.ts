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
// Repeat words are counted once (a bounded cache), and the work stops for the event loop every
// so often, so a long document doesn't hold up the worker's other jobs.
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
// Stop for the event loop after this many counts.
const YIELD_EVERY = 2000;
// The most distinct words kept in the count cache.
const CACHE_LIMIT = 100_000;

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
  private counts = 0;

  constructor(private readonly counter: TokenCounter) {}

  async count(piece: string): Promise<number> {
    const cached = this.cache.get(piece);
    if (cached !== undefined) return cached;
    const n = this.counter.count(piece);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(piece, n);
    this.counts += 1;
    if (this.counts % YIELD_EVERY === 0) await yieldToLoop();
    return n;
  }
}

// Adds the units of the word text[start, end) to `out`, splitting it while a part is over `cap`
// tokens or too long to count.
async function addWord(
  text: string,
  start: number,
  end: number,
  cap: number,
  counter: UnitCounter,
  out: Unit[],
): Promise<void> {
  const parts: Array<[number, number]> = [[start, end]];
  while (parts.length > 0) {
    const [s, e] = parts.pop()!;
    const single = e - s === 1 || (e - s === 2 && text.charCodeAt(s) >= 0xd800 && text.charCodeAt(s) <= 0xdbff);
    if (e - s > MAX_COUNTED_LENGTH && !single) {
      const mid = middle(text, s, e);
      parts.push([mid, e], [s, mid]);
      continue;
    }
    const tokens = await counter.count(text.slice(s, e));
    if (tokens > cap && !single) {
      const mid = middle(text, s, e);
      parts.push([mid, e], [s, mid]);
      continue;
    }
    if (tokens > 0) out.push({ start: s, end: e, tokens });
  }
}

/** The units of a text (see the top of the file), in order, each at most `cap` tokens. */
async function unitsOf(text: string, cap: number, counter: UnitCounter): Promise<Unit[]> {
  const units: Unit[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    await addWord(text, m.index, m.index + m[0].length, cap, counter, units);
  }
  return units;
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
  const units = await unitsOf(text, Math.min(MAX_UNIT_TOKENS, maxTokens), new UnitCounter(counter));
  const chunks: TextChunk[] = [];
  let first = 0;
  let prevLast = -1;

  while (first < units.length) {
    // As many units as fit, by their counts.
    let last = first;
    let sum = units[first]!.tokens;
    while (last + 1 < units.length && sum + units[last + 1]!.tokens <= maxTokens) {
      last += 1;
      sum += units[last]!.tokens;
    }
    // The slice counted as a whole; units come off the end while it is over (never back to the
    // previous window's end, so every window adds something).
    let slice = text.slice(units[first]!.start, units[last]!.end);
    let tokenCount = counter.count(slice);
    while (tokenCount > maxTokens && last > Math.max(first, prevLast + 1)) {
      last -= 1;
      slice = text.slice(units[first]!.start, units[last]!.end);
      tokenCount = counter.count(slice);
    }
    if (tokenCount > maxTokens) {
      if (first <= prevLast) {
        // The overlap left no room: this window starts after the previous one instead.
        first = prevLast + 1;
        continue;
      }
      throw new Error('chunkText: a unit is over the token limit');
    }
    if (tokenCount > 0) {
      chunks.push({
        position: chunks.length,
        text: slice,
        startOffset: units[first]!.start,
        endOffset: units[last]!.end,
        tokenCount,
      });
    }
    if (last === units.length - 1) break;

    // The next start: the overlap closest to `overlapTokens` (the larger on a tie), after `first`.
    let next = last + 1;
    if (overlapTokens > 0) {
      let overlap = 0;
      let bestStart = last + 1;
      let bestGap = overlapTokens;
      for (let k = last; k > first; k -= 1) {
        overlap += units[k]!.tokens;
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
    await yieldToLoop();
  }
  return chunks;
}
