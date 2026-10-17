// The Home dashboard (S8-009, D27 screen 1), after ServiceNow's IRM workspace overview (D2): the
// headline figures, then where the risks sit, how the records split, framework coverage and what
// to open first. Every tile comes from one answer of GET /api/v1/dashboard, which counts only what
// this person may see and leaves out each section their role can't view (D7, D50, D51): a tile
// shows only when its section is there. Framework coverage and waiting for review come from their
// own screens' routes, asked only by the roles that use them. While it loads the tiles' shapes
// show; if it fails, the API's message and reference ID do (D47).
import { hasDashboardSection } from '@grc/shared';
import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment } from '@/features/records/format';
import { FrameworkCoverageTile } from './FrameworkCoverageTile';
import { Headlines, HeadlinesPlaceholder } from './Headlines';
import { IntakeTile } from './IntakeTile';
import { AssetsTile, ControlsTile, IncidentsBySeverityTile, NewestIncidentsTile } from './RecordTiles';
import { HeatMapTile, RisksByBandTile, TopRisksTile } from './RiskTiles';
import { TilePlaceholder } from './Tile';
import {
  seesFrameworks,
  seesReviewQueue,
  useDashboard,
  useFrameworkCoverage,
  useWaitingForReview,
} from './useDashboard';

/** Two tiles a row on wide screens; a row's lone last tile takes the whole width. */
function Pair({ children }: { children: ReactNode[] }) {
  const shown = children.filter(Boolean);
  if (shown.length === 0) return null;
  return <div className="grid gap-6 lg:grid-cols-2 lg:[&>:last-child:nth-child(odd)]:col-span-2">{shown}</div>;
}

function DashboardPlaceholder() {
  return (
    <div className="grid gap-6" role="status">
      <span className="sr-only">Loading the dashboard…</span>
      <HeadlinesPlaceholder />
      <div className="grid gap-6 lg:grid-cols-2">
        <TilePlaceholder rows={6} />
        <TilePlaceholder rows={6} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <TilePlaceholder />
        <TilePlaceholder />
      </div>
    </div>
  );
}

/** The dashboard's main column. */
export function Dashboard({ role }: { role: string }) {
  const dashboard = useDashboard();
  const waiting = useWaitingForReview(role);
  const frameworks = useFrameworkCoverage(role);

  if (dashboard.isPending) return <DashboardPlaceholder />;
  if (dashboard.isError) {
    return (
      <ApiProblem error={dashboard.error} title="The dashboard couldn't be shown">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2 w-fit"
          disabled={dashboard.isFetching}
          onClick={() => void dashboard.refetch()}
        >
          <RotateCw aria-hidden />
          Try again
        </Button>
      </ApiProblem>
    );
  }

  const { risks, controls, incidents, assets } = dashboard.data;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Headlines
          dashboard={dashboard.data}
          waiting={{
            shown: seesReviewQueue(role),
            pending: waiting.isPending,
            failed: waiting.isError,
            data: waiting.data,
          }}
        />
        <p className="text-muted-foreground text-xs">
          Counted {formatMoment(dashboard.data.countedAt)}, from the records you can see.
        </p>
      </div>

      <Pair>
        {[
          risks ? <HeatMapTile key="heat-map" risks={risks} /> : null,
          risks ? <TopRisksTile key="top-risks" risks={risks} /> : null,
        ]}
      </Pair>

      <Pair>
        {[
          risks ? <RisksByBandTile key="bands" risks={risks} /> : null,
          controls ? <ControlsTile key="controls" controls={controls} /> : null,
          incidents ? <IncidentsBySeverityTile key="incident-severity" incidents={incidents} /> : null,
          assets ? <AssetsTile key="assets" assets={assets} /> : null,
        ]}
      </Pair>

      <Pair>
        {[
          seesFrameworks(role) ? <FrameworkCoverageTile key="frameworks" role={role} query={frameworks} /> : null,
          incidents ? <NewestIncidentsTile key="newest-incidents" incidents={incidents} /> : null,
        ]}
      </Pair>
    </div>
  );
}

/** The dashboard's tile in the side column: Data intake, for the roles that get its section. Its
 * placeholder shows only for the roles the API sends the section to; the answer decides the rest. */
export function DashboardSide({ role }: { role: string }) {
  const dashboard = useDashboard();
  if (dashboard.isPending) return hasDashboardSection(role, 'documents') ? <TilePlaceholder rows={5} /> : null;
  const documents = dashboard.data?.documents;
  return documents ? <IntakeTile documents={documents} /> : null;
}
