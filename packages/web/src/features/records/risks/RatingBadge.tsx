// A risk's rating (D197): the score (impact × likelihood) beside its band, coloured like a
// ServiceNow heat-map cell.
import { cn } from '@/lib/utils';
import { words } from '../format';

export type Band = 'low' | 'medium' | 'high' | 'critical';

const BAND_TONE: Record<Band, string> = {
  low: 'bg-[#e4f2e9] text-[#1f5c38] border-[#9fcdb1]',
  medium: 'bg-[#fdf3d8] text-[#7a5a0c] border-[#e8c96b]',
  high: 'bg-[#fde6d6] text-[#9a3a0b] border-[#f0a878]',
  critical: 'bg-[#b42318] text-white border-[#b42318]',
};

const SCORE_TONE: Record<Band, string> = {
  low: 'text-[#1f5c38]',
  medium: 'text-[#7a5a0c]',
  high: 'text-[#9a3a0b]',
  critical: 'text-[#b42318]',
};

function asBand(value: string): Band {
  return value === 'medium' || value === 'high' || value === 'critical' ? value : 'low';
}

export function RatingBadge({ score, band, size = 'sm' }: { score: number; band: string; size?: 'sm' | 'lg' }) {
  const b = asBand(band);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        className={cn(
          'min-w-[2ch] text-right font-bold tabular-nums',
          size === 'lg' ? 'text-3xl leading-none' : 'text-sm',
          SCORE_TONE[b],
        )}
      >
        {score}
      </span>{' '}
      <span
        className={cn(
          'rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold',
          size === 'lg' && 'px-2 py-1 text-sm',
          BAND_TONE[b],
        )}
      >
        {words(b)}
      </span>
    </span>
  );
}
