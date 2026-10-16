// Where a link finding's sentence sits in its chunk's text (S5-002; D39, D52.5; S4 shared notes,
// "Rule checks"), found the way S4's `same_sentence` check finds it: both texts in one canonical
// Unicode form (NFC), every run of white space one space, trimmed, and the sentence looked for in
// the chunk's text. The answer is the place in the chunk's own text (UTF-16 offsets, `end`
// exclusive), so the screen can highlight it as written; `null` when the sentence isn't there.
// Pure: no I/O, and nothing here is ever logged (the texts are the document's, D163).
import type { SentencePlace } from '@grc/shared';

// One piece of the squashed text and where it came from in the original: a run of white space
// (one space), or a cluster of a character and its combining marks (in NFC).
interface Piece {
  /** The piece's place in the original text. */
  start: number;
  end: number;
  /** The piece's place in the squashed text. */
  flatStart: number;
  flatEnd: number;
  /** Whether its squashed form has the original's length, so offsets inside it map one to one. */
  sameLength: boolean;
}

interface Squashed {
  text: string;
  pieces: Piece[];
}

/** Text with its spacing ignored, as S4's `same_sentence` check squashes it. */
function squash(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

const RUNS = /(\p{White_Space}+)|(\P{White_Space}+)/gu;
const CLUSTERS = /\P{M}\p{M}*|\p{M}+/gu;

// The squashed text with a map back to the original. `fine` splits each word into its clusters, so
// a sentence that starts or ends inside a word whose NFC form is shorter still maps exactly; when
// cluster-by-cluster NFC isn't the word's NFC (rare scripts), each word is one piece instead.
function squashWithMap(text: string, fine: boolean): Squashed {
  const pieces: Piece[] = [];
  let flat = '';
  const runs = [...text.matchAll(RUNS)];
  runs.forEach((run, i) => {
    const start = run.index;
    const original = run[0];
    if (run[1] !== undefined) {
      // White space: dropped at either end (trimmed), else one space.
      if (i === 0 || i === runs.length - 1) return;
      pieces.push({
        start,
        end: start + original.length,
        flatStart: flat.length,
        flatEnd: flat.length + 1,
        sameLength: original.length === 1,
      });
      flat += ' ';
      return;
    }
    const parts = fine
      ? [...original.matchAll(CLUSTERS)].map((m) => ({ at: start + m.index, text: m[0] }))
      : [{ at: start, text: original }];
    for (const part of parts) {
      const normal = part.text.normalize('NFC');
      pieces.push({
        start: part.at,
        end: part.at + part.text.length,
        flatStart: flat.length,
        flatEnd: flat.length + normal.length,
        sameLength: normal.length === part.text.length,
      });
      flat += normal;
    }
  });
  return { text: flat, pieces };
}

// The piece holding the squashed offset (`flatStart <= at < flatEnd`), by binary search.
function pieceAt(pieces: readonly Piece[], at: number): Piece | undefined {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pieces[mid]!;
    if (at < p.flatStart) hi = mid - 1;
    else if (at >= p.flatEnd) lo = mid + 1;
    else return p;
  }
  return undefined;
}

/**
 * Where `sentence` sits in `chunkText`, spacing ignored: the first place it appears, as offsets in
 * the chunk's own text. `null` when either text is empty after squashing or the sentence isn't in
 * the chunk.
 */
export function locateSentence(chunkText: string, sentence: string): SentencePlace | null {
  if (typeof chunkText !== 'string' || typeof sentence !== 'string') return null;
  const target = squash(sentence);
  if (target === '') return null;
  const whole = squash(chunkText);
  const at = whole.indexOf(target);
  if (at < 0) return null;

  // The map's squashed text must be the check's own, or offsets would point at the wrong place.
  let map = squashWithMap(chunkText, true);
  if (map.text !== whole) map = squashWithMap(chunkText, false);
  if (map.text !== whole) return null;

  const last = at + target.length - 1;
  const first = pieceAt(map.pieces, at);
  const final = pieceAt(map.pieces, last);
  if (!first || !final) return null;

  const start = first.sameLength ? first.start + (at - first.flatStart) : first.start;
  const end = final.sameLength ? final.start + (last - final.flatStart) + 1 : final.end;
  return end > start ? { start, end } : null;
}
