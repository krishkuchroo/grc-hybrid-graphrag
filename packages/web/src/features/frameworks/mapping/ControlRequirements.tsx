// "Requirements this control satisfies" on a control page (S2-007, D67, D212 (3)): the control's
// SATISFIES links from GET /api/v1/controls/:id/requirements, one group per framework, each row
// linking to the requirement's page. These are the real mapping; the control's Source note is free
// text and never counts (D212 (5)). "Add requirement" shows only when `canMapControl` holds (Admin
// and Compliance Manager, for a control they can see; never a Control Owner, even on their own
// control), and "Remove" on a row only when it also isn't an AI mapping (D207). The API decides
// (D7); the web only hides what it would refuse.
import { Link } from '@tanstack/react-router';
import { CircleCheck, Sparkles, Unlink } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '@/features/records/ApiProblem';
import { StatusBadge } from '@/features/records/RecordPage';
import type { AnyRecord } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { formatCount } from '../CoverageBar';
import { frameworkName } from '../useFrameworks';
import { AddRequirementDialog } from './AddRequirementDialog';
import { MappingRefusal, RemoveMappingDialog, type MappingTarget } from './RemoveMappingDialog';
import {
  byFramework,
  mayMapControl,
  mayRemoveMapping,
  ORIGIN_TEXT,
  useControlRequirements,
  useRemoveMapping,
  useViewer,
  type ControlRequirement,
} from './useMappings';

/** A mapping's origin as a small tag; an AI mapping says it is changed only through review. */
export function MappingOrigin({ origin }: { origin: string }) {
  const text = ORIGIN_TEXT[origin] ?? origin;
  if (origin === 'ai') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sm border border-[#c9c2e6] bg-[#f3f1fb] px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap text-[#4a3d8f]"
        title="Found by the AI. It is changed only through the Analyst's review."
      >
        <Sparkles className="size-3" aria-hidden />
        {text}
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs whitespace-nowrap">{text}</span>;
}

function FrameworkGroup({
  frameworkKey,
  items,
  canRemove,
  onRemove,
}: {
  frameworkKey: string;
  items: ControlRequirement[];
  canRemove: (row: ControlRequirement) => boolean;
  onRemove: (row: ControlRequirement) => void;
}) {
  const titleId = useId();
  const name = frameworkName(frameworkKey);
  const actions = items.some(canRemove);
  return (
    <section aria-labelledby={titleId} className="border-t first:border-t-0">
      <h3 id={titleId} className="bg-muted/60 flex items-center gap-2 px-5 py-2 text-[13px] font-semibold">
        {name}
        <span className="text-muted-foreground text-xs font-medium tabular-nums">{formatCount(items.length)}</span>
      </h3>
      <Table aria-label={`${name} requirements`}>
        <TableHeader>
          <TableRow className="text-muted-foreground">
            <TableHead className="w-28 pl-5">Code</TableHead>
            <TableHead>Title</TableHead>
            <TableHead className={actions ? 'w-24' : 'w-24 pr-5'}>Origin</TableHead>
            {actions ? (
              <TableHead className="w-28 pr-5 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((row) => (
            <TableRow
              key={row.id}
              className={cn('hover:bg-muted/40', row.status === 'retired' && 'text-muted-foreground')}
            >
              <TableCell className="pl-5 whitespace-nowrap">
                <Link
                  to="/requirements/$id"
                  params={{ id: row.id }}
                  className="text-primary font-semibold tabular-nums underline-offset-2 hover:underline"
                >
                  {row.code}
                </Link>
              </TableCell>
              <TableCell className="max-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate" title={row.title}>
                    {row.title}
                  </span>
                  {row.status === 'retired' ? <StatusBadge status="retired" /> : null}
                </span>
              </TableCell>
              <TableCell className={actions ? undefined : 'pr-5'}>
                <MappingOrigin origin={row.origin} />
              </TableCell>
              {actions ? (
                <TableCell className="py-1 pr-3 text-right">
                  {canRemove(row) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive h-7"
                      aria-label={`Remove mapping to ${row.code}`}
                      onClick={() => onRemove(row)}
                    >
                      <Unlink aria-hidden />
                      Remove
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function ControlRequirements({ control }: { control: AnyRecord }) {
  const title = 'Requirements this control satisfies';
  const viewer = useViewer();
  const query = useControlRequirements(control.id);
  const remove = useRemoveMapping();
  const [target, setTarget] = useState<MappingTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState<unknown>(null);

  const thisControl = { label: control.label, owner: control.owner };
  const mayMap = mayMapControl(viewer, thisControl);
  const items = query.data?.items ?? [];
  const mappedIds = new Set(items.map((r) => r.id));

  const startRemoval = (row: ControlRequirement) => {
    remove.reset();
    setNotice(null);
    setRefused(null);
    setTarget({
      control: { id: control.id, number: control.number, name: control.name, label: control.label },
      requirement: { id: row.id, code: row.code, title: row.title },
      origin: row.origin,
    });
  };

  const confirmRemoval = () => {
    if (!target) return;
    const { requirement } = target;
    remove.mutate(
      { controlId: control.id, requirementId: requirement.id },
      {
        onSuccess: () => {
          setTarget(null);
          setNotice(`${control.number} no longer satisfies ${requirement.code}.`);
        },
        onError: (error) => {
          setTarget(null);
          setRefused(error);
        },
      },
    );
  };

  return (
    <section aria-label={title} className="bg-card rounded-lg border shadow-xs">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-1.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {query.data ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {formatCount(items.length)}
            </span>
          ) : null}
        </h2>
        <p role="status" className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          {notice ? (
            <>
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              <span className="truncate">{notice}</span>
            </>
          ) : null}
        </p>
        {mayMap ? (
          <div className="ml-auto">
            <AddRequirementDialog
              control={{ id: control.id, number: control.number, name: control.name }}
              mappedIds={mappedIds}
              onMapped={(message) => {
                setRefused(null);
                setNotice(message);
              }}
            />
          </div>
        ) : null}
      </div>
      {refused ? (
        <div className="border-b p-4">
          <MappingRefusal error={refused} action="remove" />
        </div>
      ) : null}
      {query.isPending ? (
        <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading the requirements…</span>
        </div>
      ) : query.isError ? (
        <div className="p-4">
          <ApiProblem error={query.error} title="The requirements couldn’t be loaded" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground grid gap-1 px-5 py-5 text-sm">
          <p>This control doesn&apos;t satisfy any requirement yet.</p>
          <p className="text-xs">
            {mayMap
              ? 'Use Add requirement to map it to a NIST, ISO 27001 or SOC 2 requirement. The Source note doesn’t count as a mapping.'
              : 'The Source note doesn’t count as a mapping.'}
          </p>
        </div>
      ) : (
        byFramework(items).map((group) => (
          <FrameworkGroup
            key={group.key}
            frameworkKey={group.key}
            items={group.items}
            canRemove={(row) => mayRemoveMapping(viewer, thisControl, row.origin)}
            onRemove={startRemoval}
          />
        ))
      )}
      <RemoveMappingDialog
        target={target}
        pending={remove.isPending}
        onConfirm={confirmRemoval}
        onCancel={() => setTarget(null)}
      />
    </section>
  );
}
