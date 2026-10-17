// The dashboard's risk tiles (S8-009): the heat map, the risks per band and the top 5 by rating,
// each from the API's risks section, so only risks the person can see are in them (D51).
import { Link } from '@tanstack/react-router';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { RatingBadge } from '@/features/records/risks/RatingBadge';
import { words } from '@/features/records/format';
import { CountBars, type CountItem } from './Charts';
import { RiskHeatMap } from './RiskHeatMap';
import { Tile, TILE_LINK, TileEmpty } from './Tile';
import { LEVEL_COLOR, LEVELS } from './tones';
import type { DashboardRisks } from './useDashboard';

const NO_RISKS = 'No risks you can see';

function RegisterLink({ text = 'Risk register' }: { text?: string }) {
  return (
    <Link to="/risks" className={TILE_LINK}>
      {text}
      <ChevronRight aria-hidden />
    </Link>
  );
}

export function HeatMapTile({ risks }: { risks: DashboardRisks }) {
  return (
    <Tile id="dash-heat-map" title="Risk heat map" action={<RegisterLink />}>
      {risks.total === 0 ? <TileEmpty icon={ShieldAlert}>{NO_RISKS}</TileEmpty> : <RiskHeatMap risks={risks} />}
    </Tile>
  );
}

export function RisksByBandTile({ risks }: { risks: DashboardRisks }) {
  const items: CountItem[] = LEVELS.map((band) => ({
    key: band,
    label: words(band),
    count: risks.byBand[band],
    color: LEVEL_COLOR[band],
  }));
  return (
    <Tile id="dash-risk-bands" title="Risks by band" action={<RegisterLink />}>
      {risks.total === 0 ? (
        <TileEmpty icon={ShieldAlert}>{NO_RISKS}</TileEmpty>
      ) : (
        <CountBars items={items} noun={{ one: 'risk', many: 'risks' }} />
      )}
    </Tile>
  );
}

export function TopRisksTile({ risks }: { risks: DashboardRisks }) {
  return (
    <Tile
      id="dash-top-risks"
      title="Top risks"
      bodyClassName="px-0 py-0"
      action={
        <Link to="/risks" search={{ sort: '-score' }} className={TILE_LINK}>
          All by rating
          <ChevronRight aria-hidden />
        </Link>
      }
    >
      {risks.top.length === 0 ? (
        <div className="px-5 py-4">
          <TileEmpty icon={ShieldAlert}>{NO_RISKS}</TileEmpty>
        </div>
      ) : (
        <ol className="divide-y">
          {risks.top.map((risk) => (
            <li key={risk.id} className="flex items-center gap-4 px-5 py-3">
              <Link
                to="/risks/$id"
                params={{ id: risk.id }}
                className="group grid min-w-0 flex-1 gap-0.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="text-primary text-xs font-semibold tabular-nums group-hover:underline">
                  {risk.number}
                </span>
                <span className="truncate text-sm">{risk.name}</span>
              </Link>
              <span className="text-muted-foreground hidden text-xs whitespace-nowrap tabular-nums sm:inline">
                <span aria-hidden>
                  {risk.impact} × {risk.likelihood}
                </span>
                <span className="sr-only">
                  Impact {risk.impact}, likelihood {risk.likelihood}, rated
                </span>
              </span>
              <RatingBadge score={risk.rating} band={risk.band} />
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}
