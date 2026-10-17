// Framework coverage on Home (S8-009): one row per framework the person can see, with the
// Frameworks screen's own coverage bar and sentence, each opening the framework's page. The counts
// are the API's SATISFIES answer for this person (D51), from the same list the Frameworks screen
// shows, so the two always agree. A role that sees only the controls it owns is told so.
import { isRole, ROLE_TABLE } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Library, UserCheck } from 'lucide-react';
import type { GetFrameworksResponse } from '@/api/client';
import { ApiProblem } from '@/features/records/ApiProblem';
import { CoverageBar, coveredPercent, coverageSentence } from '@/features/frameworks/CoverageBar';
import { Placeholder, Tile, TILE_LINK, TileEmpty } from './Tile';

type Framework = GetFrameworksResponse['items'][number];

function FrameworkRow({ framework }: { framework: Framework }) {
  const coverage = {
    total: framework.requirementCount,
    covered: framework.coveredCount,
    implemented: framework.implementedCount,
  };
  return (
    <li className="grid gap-1.5 px-5 py-3">
      <div className="flex items-baseline gap-3">
        <Link
          to="/frameworks/$id"
          params={{ id: framework.id }}
          className="text-primary min-w-0 truncate rounded-sm text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {framework.name}
        </Link>
        <span className="ml-auto shrink-0 text-sm font-bold tabular-nums">{coveredPercent(coverage)}%</span>
      </div>
      <CoverageBar coverage={coverage} />
      <p className="text-muted-foreground text-xs">{coverageSentence(coverage)}</p>
    </li>
  );
}

export function FrameworkCoverageTile({
  role,
  query,
}: {
  role: string;
  query: { isPending: boolean; isError: boolean; error: unknown; data: GetFrameworksResponse | undefined };
}) {
  const onlyOwn = isRole(role) && ROLE_TABLE.control[role] === 'edit_own';
  let body;
  if (query.data) {
    body =
      query.data.items.length === 0 ? (
        <div className="px-5 py-4">
          <TileEmpty icon={Library}>No frameworks you can see</TileEmpty>
        </div>
      ) : (
        <ul className="divide-y">
          {query.data.items.map((framework) => (
            <FrameworkRow key={framework.id} framework={framework} />
          ))}
        </ul>
      );
  } else if (query.isError) {
    body = (
      <div className="px-5 py-4">
        <ApiProblem error={query.error} title="Framework coverage couldn't be shown" />
      </div>
    );
  } else {
    body = (
      <div aria-hidden className="grid gap-5 px-5 py-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="grid gap-2">
            <Placeholder className="h-3.5 w-40" />
            <Placeholder className="h-2 w-full rounded-full" />
            <Placeholder className="h-3 w-56" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Tile
      id="dash-frameworks"
      title="Framework coverage"
      bodyClassName="px-0 py-0"
      action={
        <Link to="/frameworks" className={TILE_LINK}>
          Frameworks
          <ChevronRight aria-hidden />
        </Link>
      }
    >
      {query.isPending && !query.data ? (
        <p role="status" className="sr-only">
          Loading framework coverage…
        </p>
      ) : null}
      {body}
      {onlyOwn && query.data && query.data.items.length > 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 border-t px-5 py-2.5 text-xs">
          <UserCheck className="text-primary size-3.5 shrink-0" aria-hidden />
          Coverage here counts only the controls you own.
        </p>
      ) : null}
    </Tile>
  );
}
