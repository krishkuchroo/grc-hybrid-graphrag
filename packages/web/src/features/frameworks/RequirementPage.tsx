// One requirement (D27, screen 7), in the ServiceNow form style (D2): its code as the title, its
// framework, group and parent, the controls that satisfy it and its links to other frameworks, both
// ways. Everything comes from the API, limited to what the person can see (D7, D51): a hidden
// control neither shows nor counts, and coverage is only ever the API's SATISFIES answer, never a
// control's Source note (D212 (5)). Catalogs are read-only here.
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { formatMoment, words } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { RecordNotFound, StatusBadge } from '@/features/records/RecordPage';
import { isNotFound } from '@/features/records/useRecords';
import { ValueBadge } from '@/features/records/ValueBadge';
import { cn } from '@/lib/utils';
import { CoverageState, formatCount } from './CoverageBar';
import {
  frameworkName,
  groupLabel,
  parentCodeOf,
  useFrameworks,
  useParentRequirement,
  useRequirement,
  type FrameworkSummary,
  type RelatedRequirement,
  type RequirementDetail,
  type SatisfyingControl,
} from './useFrameworks';

// ---- Pieces -------------------------------------------------------------------------------

function BackToFrameworks() {
  return (
    <Link to="/frameworks" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Frameworks
    </Link>
  );
}

function Panel({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn('bg-card rounded-lg border shadow-xs', className)}>
      <h2 className="flex items-center gap-2 border-b px-5 py-2.5 text-sm font-semibold">
        {title}
        {count !== undefined ? (
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
            {formatCount(count)}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

interface DetailItem {
  label: string;
  value: ReactNode;
  wide?: boolean;
}

function Sheet({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 px-5 py-5 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className={cn('grid gap-1', item.wide && 'sm:col-span-2')}>
          <dt className="text-muted-foreground text-xs font-semibold">{item.label}</dt>{' '}
          <dd className="text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground grid gap-1 px-5 py-6 text-sm">{children}</div>;
}

/** The framework as a link to its page when the person can see it in the list, else its name. */
function FrameworkLink({ framework, fallbackKey }: { framework: FrameworkSummary | undefined; fallbackKey: string }) {
  if (!framework) return <span>{frameworkName(fallbackKey)}</span>;
  return (
    <Link to="/frameworks/$id" params={{ id: framework.id }} className="text-primary font-semibold hover:underline">
      {framework.name}
    </Link>
  );
}

// ---- Sections ---------------------------------------------------------------------------------

function SatisfyingControls({ controls }: { controls: SatisfyingControl[] }) {
  return (
    <Panel title="Controls that satisfy this requirement" count={controls.length}>
      {controls.length === 0 ? (
        <EmptyNote>
          <p>No control you can see satisfies this requirement.</p>
        </EmptyNote>
      ) : (
        <Table>
          <TableHeader className="bg-muted/70">
            <TableRow>
              <TableHead className="pl-5">Number</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead className="pr-5">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {controls.map((control) => (
              <TableRow
                key={control.id}
                className={cn(
                  'even:bg-muted/30 hover:bg-accent/60',
                  control.status === 'retired' && 'text-muted-foreground',
                )}
              >
                <TableCell className="pl-5">
                  <Link
                    to="/controls/$id"
                    params={{ id: control.id }}
                    className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
                  >
                    {control.number}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="line-clamp-2 min-w-[12rem]">{control.name}</span>
                </TableCell>
                <TableCell className="font-medium whitespace-nowrap">{control.code}</TableCell>
                <TableCell className="pr-5">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <ValueBadge value={control.controlStatus} />
                    {control.status === 'retired' ? <StatusBadge status="retired" /> : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function RelatedTable({
  title,
  items,
  frameworks,
}: {
  title: string;
  items: RelatedRequirement[];
  frameworks: FrameworkSummary[];
}) {
  return (
    <div>
      <h3 className="text-muted-foreground bg-muted/60 border-b px-5 py-1.5 text-xs font-semibold">{title}</h3>
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%] pl-5">Framework</TableHead>
            <TableHead>Code</TableHead>
            <TableHead className="pr-5">Title</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const framework = frameworks.find((f) => f.key === item.framework);
            return (
              <TableRow key={`${item.direction}:${item.id}`} className="hover:bg-accent/60">
                <TableCell className="pl-5 whitespace-nowrap">
                  {framework?.name ?? frameworkName(item.framework)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Link
                    to="/requirements/$id"
                    params={{ id: item.id }}
                    className="text-primary font-semibold tabular-nums hover:underline"
                  >
                    {item.code}
                  </Link>
                </TableCell>
                <TableCell className="pr-5">
                  <span className="line-clamp-2 min-w-[12rem]">{item.title}</span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function RelatedRequirements({
  requirement,
  frameworks,
}: {
  requirement: RequirementDetail;
  frameworks: FrameworkSummary[];
}) {
  const out = requirement.mapsTo.filter((m) => m.direction === 'out');
  const into = requirement.mapsTo.filter((m) => m.direction === 'in');
  return (
    <Panel title="Related requirements in other frameworks" count={requirement.mapsTo.length}>
      {requirement.mapsTo.length === 0 ? (
        <EmptyNote>
          <p>This requirement has no related requirements in other frameworks.</p>
          {requirement.framework === 'soc_2' ? (
            <p className="text-xs">Only NIST&apos;s own mappings are loaded, and they don&apos;t cover SOC 2.</p>
          ) : null}
        </EmptyNote>
      ) : (
        <>
          {out.length > 0 ? (
            <RelatedTable title={`${requirement.code} maps to`} items={out} frameworks={frameworks} />
          ) : null}
          {into.length > 0 ? (
            <RelatedTable title={`Mapped to ${requirement.code}`} items={into} frameworks={frameworks} />
          ) : null}
        </>
      )}
    </Panel>
  );
}

/** The requirement's coverage for the person, from the API's SATISFIES links to controls they can see. */
function CoveragePanel({ controls }: { controls: SatisfyingControl[] }) {
  const active = controls.filter((c) => c.status === 'active');
  const implemented = active.filter((c) => c.controlStatus === 'implemented').length;
  const covered = active.length > 0;
  let note: string;
  if (!covered) note = 'No active control you can see satisfies it.';
  else {
    const noun = active.length === 1 ? 'active control' : 'active controls';
    note = `Satisfied by ${formatCount(active.length)} ${noun} you can see, ${formatCount(implemented)} implemented.`;
  }
  return (
    <Panel title="Coverage">
      <div className="grid gap-1.5 px-5 py-4">
        <span className="text-sm font-semibold">
          <CoverageState covered={covered} implemented={implemented > 0} />
        </span>
        <p className="text-muted-foreground text-xs leading-relaxed">{note}</p>
      </div>
    </Panel>
  );
}

// ---- The page ---------------------------------------------------------------------------------

export function RequirementPage({ id }: { id: string }) {
  const query = useRequirement(id);
  const frameworks = useFrameworks();
  const requirement = query.data;
  const framework = frameworks.data?.items.find((f) => f.key === requirement?.framework);
  const parentCode = requirement ? parentCodeOf(requirement) : null;
  const parent = useParentRequirement(framework?.id, parentCode);

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-3 px-8 py-10 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Opening the requirement…</span>
      </div>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) return <RecordNotFound back={<BackToFrameworks />} />;
    return (
      <div className="grid gap-4 px-8 py-8">
        <div className="text-muted-foreground text-xs">
          <BackToFrameworks />
        </div>
        <ApiProblem error={query.error} title="This requirement couldn't be opened" />
      </div>
    );
  }

  const r = query.data;
  const known = frameworks.data?.items ?? [];

  const details: DetailItem[] = [
    {
      label: 'Description',
      value: <p className="max-w-[75ch] leading-relaxed whitespace-pre-line">{r.description}</p>,
      wide: true,
    },
    { label: 'Framework', value: <FrameworkLink framework={framework} fallbackKey={r.framework} /> },
    { label: 'Group', value: groupLabel(r.framework, r.group) },
  ];
  if (parentCode !== null) {
    const found = parent.data;
    details.push({
      label: 'Parent',
      value: found ? (
        <Link to="/requirements/$id" params={{ id: found.id }} className="text-primary font-semibold hover:underline">
          {found.code} {found.title}
        </Link>
      ) : (
        <span className="font-semibold">{parentCode}</span>
      ),
    });
  }
  details.push(
    { label: 'Number', value: <span className="tabular-nums">{r.number}</span> },
    { label: 'Status', value: <StatusBadge status={r.status} /> },
  );

  return (
    <>
      <div className="bg-card border-b px-8 pt-4 pb-5">
        <nav aria-label="Breadcrumb" className="text-muted-foreground mb-2 text-xs">
          <ol className="flex flex-wrap items-center gap-1">
            <li>
              <Link to="/frameworks" className="hover:text-primary font-semibold">
                Frameworks
              </Link>
            </li>
            <li aria-hidden>
              <ChevronRight className="size-3.5" />
            </li>
            <li>
              {framework ? (
                <Link to="/frameworks/$id" params={{ id: framework.id }} className="hover:text-primary font-semibold">
                  {framework.name}
                </Link>
              ) : (
                <span className="font-semibold">{frameworkName(r.framework)}</span>
              )}
            </li>
          </ol>
        </nav>
        <div className="grid min-w-0 gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{r.code}</h1>
            <StatusBadge status={r.status} />
          </div>
          <p className="text-foreground max-w-[70ch] text-[0.95rem]">{r.title}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <Panel title="Details">
            <Sheet items={details} />
          </Panel>
          <SatisfyingControls controls={r.controls} />
          <RelatedRequirements requirement={r} frameworks={known} />
        </div>

        <aside className="grid content-start gap-4">
          <CoveragePanel controls={r.controls} />
          <Panel title="Record">
            <Sheet
              items={[
                { label: 'Label', value: <LabelBadge label={r.label} />, wide: true },
                { label: 'Origin', value: words(r.origin), wide: true },
                { label: 'Updated', value: formatMoment(r.updatedAt), wide: true },
              ]}
            />
          </Panel>
        </aside>
      </div>
    </>
  );
}
