// Frameworks (D27, screen 7): the framework catalogs loaded for the org, each with its version and
// publisher and how much of it the person's visible controls cover, as the API counted it (D51).
// Each framework opens its requirements. Catalogs are read-only here: nothing offers to edit them.
import { Link } from '@tanstack/react-router';
import { isRole, ROLE_TABLE } from '@grc/shared';
import { UserCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { useMe } from '@/features/records/useRecords';
import { CoverageBar, coveredPercent, coverageSentence, formatCount } from './CoverageBar';
import { useFrameworks, type FrameworkSummary } from './useFrameworks';

const SCREEN = SCREENS.find((s) => s.path === '/frameworks')!;

/** Shown to a role that sees only the controls it owns (`edit_own` on controls). */
const OWN_NOTE = 'Coverage here counts only the controls you own.';

function coverageOf(framework: FrameworkSummary) {
  return {
    total: framework.requirementCount,
    covered: framework.coveredCount,
    implemented: framework.implementedCount,
  };
}

function FrameworkRow({ framework }: { framework: FrameworkSummary }) {
  const coverage = coverageOf(framework);
  return (
    <TableRow className="hover:bg-accent/40">
      <TableCell className="min-w-[16rem] py-3.5 pl-5">
        <div className="grid max-w-[46ch] gap-1">
          <Link
            to="/frameworks/$id"
            params={{ id: framework.id }}
            className="text-primary text-sm font-semibold hover:underline"
          >
            {framework.name}
          </Link>
          <p className="text-muted-foreground text-xs leading-relaxed whitespace-normal">{framework.description}</p>
        </div>
      </TableCell>
      <TableCell className="min-w-[17rem] py-3.5">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-3">
            <CoverageBar coverage={coverage} />
            <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">
              {coveredPercent(coverage)}%
            </span>
          </div>
          <p className="text-muted-foreground text-xs whitespace-normal">{coverageSentence(coverage)}</p>
        </div>
      </TableCell>
      <TableCell className="py-3.5 text-right tabular-nums">{formatCount(framework.requirementCount)}</TableCell>
      <TableCell className="max-w-[11rem] min-w-[5rem] py-3.5 whitespace-normal">
        {framework.frameworkVersion}
      </TableCell>
      <TableCell className="py-3.5 pr-5 whitespace-nowrap">{framework.publisher}</TableCell>
    </TableRow>
  );
}

export function FrameworkList() {
  const me = useMe();
  const frameworks = useFrameworks();
  const role = me.data?.role;
  const onlyOwn = role !== undefined && isRole(role) && ROLE_TABLE.control[role] === 'edit_own';

  let body: ReactNode;
  if (frameworks.isPending) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-6 py-16 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Loading frameworks…</span>
      </div>
    );
  } else if (frameworks.isError) {
    body = (
      <div className="p-6">
        <ApiProblem error={frameworks.error} title="The frameworks couldn't be shown" />
      </div>
    );
  } else if (frameworks.data.items.length === 0) {
    const Icon = SCREEN.icon;
    body = (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
          <Icon className="size-5" aria-hidden />
        </span>
        <p className="max-w-md text-sm">{SCREEN.empty}</p>
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader className="bg-muted/70">
          <TableRow>
            <TableHead className="pl-5">Framework</TableHead>
            <TableHead>Coverage</TableHead>
            <TableHead className="text-right">Requirements</TableHead>
            <TableHead>Version</TableHead>
            <TableHead className="pr-5">Publisher</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {frameworks.data.items.map((framework) => (
            <FrameworkRow key={framework.id} framework={framework} />
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <>
      <PageHeader title={SCREEN.label} summary={SCREEN.summary} />
      <div className="grid grid-cols-1 gap-4 px-8 py-6">
        {onlyOwn ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <UserCheck className="text-primary size-4 shrink-0" aria-hidden />
            {OWN_NOTE}
          </p>
        ) : null}
        <section aria-label="Frameworks list" className="bg-card rounded-lg border shadow-xs">
          {body}
        </section>
        {frameworks.data && frameworks.data.items.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            A requirement is covered when an active control you can see satisfies it, and implemented when one of those
            controls is implemented.
          </p>
        ) : null}
      </div>
    </>
  );
}
