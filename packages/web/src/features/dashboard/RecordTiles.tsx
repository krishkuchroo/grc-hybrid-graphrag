// The dashboard's control, incident and asset tiles (S8-009): controls per status, open incidents
// per severity and the 5 newest open, and assets per criticality, each from its section of the
// API's answer, so only what the person can see is in them (D50, D51).
import { CONTROL_STATUSES } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Server, ShieldCheck, Siren } from 'lucide-react';
import { formatDay, words } from '@/features/records/format';
import { ValueBadge } from '@/features/records/ValueBadge';
import { CountBars, CountRing, type CountItem } from './Charts';
import { Tile, TILE_LINK, TileEmpty } from './Tile';
import { CONTROL_STATUS_COLOR, LEVEL_COLOR, LEVELS } from './tones';
import type { DashboardAssets, DashboardControls, DashboardIncidents } from './useDashboard';

const NO_OPEN_INCIDENTS = 'No open incidents';

function levelItems(counts: Readonly<Record<(typeof LEVELS)[number], number>>): CountItem[] {
  return LEVELS.map((level) => ({ key: level, label: words(level), count: counts[level], color: LEVEL_COLOR[level] }));
}

function IncidentsLink() {
  return (
    <Link to="/incidents" className={TILE_LINK}>
      Incidents
      <ChevronRight aria-hidden />
    </Link>
  );
}

export function ControlsTile({ controls }: { controls: DashboardControls }) {
  // Implemented first, then planned, then not implemented: the order work moves in, read from done.
  const items: CountItem[] = [...CONTROL_STATUSES].reverse().map((status) => ({
    key: status,
    label: words(status),
    count: controls.byStatus[status],
    color: CONTROL_STATUS_COLOR[status],
  }));
  return (
    <Tile
      id="dash-controls"
      title="Controls by status"
      action={
        <Link to="/controls" className={TILE_LINK}>
          Controls
          <ChevronRight aria-hidden />
        </Link>
      }
    >
      {controls.total === 0 ? (
        <TileEmpty icon={ShieldCheck}>No controls you can see</TileEmpty>
      ) : (
        <CountRing items={items} noun={{ one: 'control', many: 'controls' }} />
      )}
    </Tile>
  );
}

export function IncidentsBySeverityTile({ incidents }: { incidents: DashboardIncidents }) {
  return (
    <Tile id="dash-incident-severity" title="Open incidents by severity" action={<IncidentsLink />}>
      {incidents.open === 0 ? (
        <TileEmpty icon={Siren}>{NO_OPEN_INCIDENTS}</TileEmpty>
      ) : (
        <CountBars
          items={levelItems(incidents.openBySeverity)}
          noun={{ one: 'open incident', many: 'open incidents' }}
          layout="rows"
        />
      )}
    </Tile>
  );
}

export function NewestIncidentsTile({ incidents }: { incidents: DashboardIncidents }) {
  return (
    <Tile id="dash-newest-incidents" title="Newest open incidents" bodyClassName="px-0 py-0" action={<IncidentsLink />}>
      {incidents.newestOpen.length === 0 ? (
        <div className="px-5 py-4">
          <TileEmpty icon={Siren}>{NO_OPEN_INCIDENTS}</TileEmpty>
        </div>
      ) : (
        <ul className="divide-y">
          {incidents.newestOpen.map((incident) => (
            <li key={incident.id} className="flex items-center gap-4 px-5 py-3">
              <Link
                to="/incidents/$id"
                params={{ id: incident.id }}
                className="group grid min-w-0 flex-1 gap-0.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="text-primary text-xs font-semibold tabular-nums group-hover:underline">
                  {incident.number}
                </span>
                <span className="truncate text-sm">{incident.name}</span>
                <span className="text-muted-foreground text-xs">
                  {words(incident.incidentStatus)}, occurred {formatDay(incident.occurredAt)}
                </span>
              </Link>
              <ValueBadge value={incident.severity} className="text-sm" />
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

export function AssetsTile({ assets }: { assets: DashboardAssets }) {
  return (
    <Tile
      id="dash-assets"
      title="Assets by criticality"
      action={
        <Link to="/assets" className={TILE_LINK}>
          Assets
          <ChevronRight aria-hidden />
        </Link>
      }
    >
      {assets.total === 0 ? (
        <TileEmpty icon={Server}>No assets you can see</TileEmpty>
      ) : (
        <CountBars items={levelItems(assets.byCriticality)} noun={{ one: 'asset', many: 'assets' }} />
      )}
    </Tile>
  );
}
