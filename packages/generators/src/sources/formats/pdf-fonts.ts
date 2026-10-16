// The two standard PDF fonts the PDF writer uses (Helvetica for the text, Helvetica-Bold for the
// title), with WinAnsiEncoding: which characters they can show, the byte each is written as, and
// each one's width, so lines can be wrapped to the page. A standard font is never embedded: every
// PDF reader has it built in. The widths are Adobe's published Core 14 AFM metrics (free to use,
// copy and distribute), in thousandths of the font size, for the codes 32 to 255.

/** The fonts the writer names, by their PDF names. */
export type PdfFont = 'Helvetica' | 'Helvetica-Bold';

const FIRST_CODE = 32;

// prettier-ignore
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 80
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 96
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350, // 112
  556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, // 128
  350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, // 144
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 160
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 176
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 192
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 208
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, // 224
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, // 240
];

// prettier-ignore
const HELVETICA_BOLD_WIDTHS: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // 32
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, // 48
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, // 64
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, // 80
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // 96
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350, // 112
  556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, // 128
  350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, // 144
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 160
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 176
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 192
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 208
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, // 224
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556, // 240
];

const WIDTHS: Readonly<Record<PdfFont, readonly number[]>> = {
  Helvetica: HELVETICA_WIDTHS,
  'Helvetica-Bold': HELVETICA_BOLD_WIDTHS,
};

/** WinAnsiEncoding's codes 128 to 159 that hold a character, with the character each one shows. */
const WIN_ANSI_HIGH: readonly [number, number][] = [
  [0x80, 0x20ac], // Euro
  [0x82, 0x201a], // quotesinglbase
  [0x83, 0x0192], // florin
  [0x84, 0x201e], // quotedblbase
  [0x85, 0x2026], // ellipsis
  [0x86, 0x2020], // dagger
  [0x87, 0x2021], // daggerdbl
  [0x88, 0x02c6], // circumflex
  [0x89, 0x2030], // perthousand
  [0x8a, 0x0160], // Scaron
  [0x8b, 0x2039], // guilsinglleft
  [0x8c, 0x0152], // OE
  [0x8e, 0x017d], // Zcaron
  [0x91, 0x2018], // quoteleft
  [0x92, 0x2019], // quoteright
  [0x93, 0x201c], // quotedblleft
  [0x94, 0x201d], // quotedblright
  [0x95, 0x2022], // bullet
  [0x96, 0x2013], // endash
  [0x97, 0x2014], // emdash
  [0x98, 0x02dc], // tilde
  [0x99, 0x2122], // trademark
  [0x9a, 0x0161], // scaron
  [0x9b, 0x203a], // guilsinglright
  [0x9c, 0x0153], // oe
  [0x9e, 0x017e], // zcaron
  [0x9f, 0x0178], // Ydieresis
];

/**
 * Latin-1 characters left out because a PDF reader gives them back as other characters: the soft
 * hyphen (shown as a plain hyphen) and the micro sign (read back as the Greek letter mu).
 */
const READS_BACK_AS_ANOTHER = new Set([0xad, 0xb5]);

/**
 * Every character the fonts can show, with its WinAnsiEncoding byte: printable ASCII, Latin-1's
 * U+00A0 to U+00FF (but `READS_BACK_AS_ANOTHER`) and the typographic characters of codes 128 to 159.
 */
const CODES: ReadonlyMap<number, number> = (() => {
  const codes = new Map<number, number>();
  for (let c = 0x20; c <= 0x7e; c++) codes.set(c, c);
  for (let c = 0xa0; c <= 0xff; c++) if (!READS_BACK_AS_ANOTHER.has(c)) codes.set(c, c);
  for (const [code, char] of WIN_ANSI_HIGH) codes.set(char, code);
  return codes;
})();

/** The character's WinAnsiEncoding byte, or null when the standard fonts can't show it. */
export function winAnsiCode(char: string): number | null {
  const cp = char.codePointAt(0);
  if (cp === undefined || char.length !== String.fromCodePoint(cp).length) return null;
  return CODES.get(cp) ?? null;
}

/** Whether the standard fonts can show every character of the text. */
export function isWinAnsiText(text: string): boolean {
  for (const char of text) if (winAnsiCode(char) === null) return false;
  return true;
}

/** The text's WinAnsiEncoding bytes; a character the fonts can't show is a RangeError. */
export function winAnsiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === null) throw new RangeError('the text has a character the standard PDF fonts cannot show');
    bytes.push(code);
  }
  return bytes;
}

/** The text's width in points at the given size; the text must be WinAnsi text. */
export function textWidth(font: PdfFont, size: number, text: string): number {
  const widths = WIDTHS[font];
  let units = 0;
  for (const code of winAnsiBytes(text)) units += widths[code - FIRST_CODE] ?? 0;
  return (units * size) / 1000;
}
