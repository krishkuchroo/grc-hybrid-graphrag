// The risk heat map (S8-009, D197): the 5 x 5 grid of the risks the person can see, likelihood
// across and impact up, each cell coloured by the band its rating (impact x likelihood) falls in and
// holding how many risks sit there, as the API counted them. Cells with risks are filled in their
// band's strong colour; empty ones keep a pale tint so the grid's shape still reads. Screen readers
// get the occupied cells in words instead of the drawing.
import { riskRating, RISK_SCALE, type RiskBand } from '@grc/shared';
import { cn } from '@/lib/utils';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { words } from '@/features/records/format';
import { countOf } from './Tile';
import type { DashboardRisks } from './useDashboard';

const FILLED: Readonly<Record<RiskBand, string>> = {
  low: 'bg-[#cde6d6] text-[#1f5c38]',
  medium: 'bg-[#f7e2a0] text-[#5e4506]',
  high: 'bg-[#f5b98f] text-[#7a2d08]',
  critical: 'bg-[#b42318] text-white',
};

const EMPTY: Readonly<Record<RiskBand, string>> = {
  low: 'bg-[#ecf5ef]',
  medium: 'bg-[#fdf6e2]',
  high: 'bg-[#fdeee4]',
  critical: 'bg-[#f8dedb]',
};

/** The ratings each band covers (D197), for the legend. */
const BAND_RANGES: ReadonlyArray<{ band: RiskBand; range: string }> = [
  { band: 'low', range: '1–4' },
  { band: 'medium', range: '5–9' },
  { band: 'high', range: '10–16' },
  { band: 'critical', range: '20–25' },
];

const HIGH_TO_LOW = [...RISK_SCALE].reverse();

export function RiskHeatMap({ risks }: { risks: DashboardRisks }) {
  const countAt = new Map(risks.heatMap.map((cell) => [`${cell.impact}:${cell.likelihood}`, cell.count]));
  const occupied = risks.heatMap
    .filter((cell) => cell.count > 0)
    .sort((a, b) => b.impact * b.likelihood - a.impact * a.likelihood || b.impact - a.impact);

  return (
    <div className="grid gap-4">
      <div aria-hidden className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)] gap-x-2">
        <span className="text-muted-foreground flex items-center justify-center text-xs font-semibold [writing-mode:vertical-rl] rotate-180">
          Impact
        </span>
        <div className="grid grid-rows-5 gap-1">
          {HIGH_TO_LOW.map((impact) => (
            <span key={impact} className="text-muted-foreground flex items-center text-xs font-semibold tabular-nums">
              {impact}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-5 grid-rows-5 gap-1">
          {HIGH_TO_LOW.map((impact) =>
            RISK_SCALE.map((likelihood) => {
              const count = countAt.get(`${impact}:${likelihood}`) ?? 0;
              const { score, band } = riskRating(impact, likelihood);
              return (
                <span
                  key={`${impact}:${likelihood}`}
                  title={`Impact ${impact}, likelihood ${likelihood}, rating ${score} (${words(band)}): ${countOf(count, 'risk')}`}
                  className={cn(
                    'grid h-11 place-items-center rounded-[5px] tabular-nums',
                    count > 0
                      ? cn('text-base font-bold', FILLED[band])
                      : cn('text-muted-foreground text-xs', EMPTY[band]),
                  )}
                >
                  {formatCount(count)}
                </span>
              );
            }),
          )}
        </div>
        <span />
        <span />
        <div className="mt-1.5 grid grid-cols-5 gap-1">
          {RISK_SCALE.map((likelihood) => (
            <span key={likelihood} className="text-muted-foreground text-center text-xs font-semibold tabular-nums">
              {likelihood}
            </span>
          ))}
        </div>
        <span />
        <span />
        <span className="text-muted-foreground mt-0.5 text-center text-xs font-semibold">Likelihood</span>
      </div>

      <ul aria-hidden className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {BAND_RANGES.map(({ band, range }) => (
          <li key={band} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-[3px]', FILLED[band])} />
            <span className="font-semibold">{words(band)}</span>
            <span className="text-muted-foreground tabular-nums">{range}</span>
          </li>
        ))}
      </ul>

      <div className="sr-only">
        <p>Risk heat map of impact against likelihood, each from 1 to 5.</p>
        <ul>
          {occupied.map((cell) => {
            const { score, band } = riskRating(cell.impact, cell.likelihood);
            return (
              <li key={`${cell.impact}:${cell.likelihood}`}>
                {countOf(cell.count, 'risk')} at impact {cell.impact} and likelihood {cell.likelihood}, rating {score},{' '}
                {band}.
              </li>
            );
          })}
        </ul>
        <p>Every other cell has no risks.</p>
      </div>
    </div>
  );
}
