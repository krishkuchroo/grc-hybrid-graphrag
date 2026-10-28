// The product's wordmark (D262): the Warrant mark, then the name "Warrant". The mark is a W whose
// last stroke rises past the first, like a tick: a warrant is the grounds for a claim, and every
// answer here comes with its sources. It sits on a small sage tile in the chrome's colour, the same
// in the header and on the sign-in frame; the word stays text, so it is the header's name for
// screen readers. `WarrantGlyph` is the mark alone, for the Ask page's welcome.
import { cn } from '@/lib/utils';

/** The W's one stroke, drawn in a 24 × 24 box. */
const W_PATH = 'M3.25 6.75 7.6 17.5 12 9.5l4.4 8 4.85-12.75';

export function WarrantGlyph({
  className,
  strokeWidth = 2.4,
  drawn = false,
}: {
  className?: string;
  strokeWidth?: number;
  /** Draws the stroke in once as it appears (the Ask page's welcome). */
  drawn?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
    >
      <path d={W_PATH} pathLength={1} className={drawn ? 'animate-mark-draw [stroke-dasharray:1]' : undefined} />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span aria-hidden className="bg-brand text-chrome grid size-7 place-items-center rounded-[5px]">
        <WarrantGlyph className="size-[19px]" strokeWidth={2.6} />
      </span>
      <span className="text-base font-bold tracking-[-0.01em] text-white">Warrant</span>
    </div>
  );
}
