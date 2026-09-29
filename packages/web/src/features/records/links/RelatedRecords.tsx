// A record's related records, in the ServiceNow related-lists style (D2): one short table per way
// the record may link, under a plain title ("Controls that treat this risk"). Only what
// GET …/:id/links returns is shown (D51: a link is visible only if both ends are), with no count
// or placeholder for anything left out. "Add link" shows when the person could add one (D200), and
// "Remove" on a row when they could add that link and it isn't one the AI found (D201, D207).
import { can, canLinkRecords, isLabel, isRemovableLinkOrigin, type Label, type RecordKind } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDownLeft, ArrowUpRight, CircleCheck, Unlink } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiProblem } from '../ApiProblem';
import { LabelBadge } from '../LabelBadge';
import type { Viewer } from '../permissions';
import { StatusBadge } from '../RecordPage';
import { useMe, type AnyRecord } from '../useRecords';
import { AddLinkDialog } from './AddLinkDialog';
import { linkGroups, offeredWays, type LinkGroup, type LinkWay } from './linkGroups';
import { RemovalRefusal, RemoveLinkDialog, type RemovalTarget } from './RemoveLinkDialog';
import { useRecordLinks, useRemoveLink, type RecordLink } from './useLinks';
import type { PostLinksRemoveBody } from '@/api/client';

const PAGE_OF = {
  risk: '/risks/$id',
  control: '/controls/$id',
  policy: '/policies/$id',
  asset: '/assets/$id',
  incident: '/incidents/$id',
} as const satisfies Record<RecordKind, string>;

/** The link to another record's page, by its number. */
export function RecordNumberLink({ kind, id, number }: { kind: RecordKind; id: string; number: string }) {
  return (
    <Link
      to={PAGE_OF[kind]}
      params={{ id }}
      className="text-primary font-semibold tabular-nums underline-offset-2 hover:underline"
    >
      {number}
    </Link>
  );
}

function wayOf(group: LinkGroup, link: RecordLink): LinkWay | undefined {
  return group.ways.find((w) => w.type === link.type && w.direction === link.direction && w.other === link.other.kind);
}

/**
 * The other end as `canLinkRecords` needs it. A link row carries no owner, but the API returns only
 * rows whose other end the person can see (D51): where the role sees a kind only as its owner
 * (`edit_own`, a Control Owner's controls), a row of that kind is one they own. Elsewhere ownership
 * changes nothing, so it's left empty.
 */
function otherEnd(viewer: Viewer, link: RecordLink) {
  const kind = link.other.kind;
  const seenOnlyAsOwner =
    !can(viewer.role, kind, 'view', { isOwner: false }) && can(viewer.role, kind, 'view', { isOwner: true });
  return { kind, label: link.other.label, owner: seenOnlyAsOwner ? viewer.userId : '' };
}

/** Whether the row gets "Remove": the person could add this link (D200) and it isn't an AI link (D207). */
function mayRemove(
  viewer: Viewer | null,
  thisEnd: { kind: RecordKind; label: string; owner: string },
  link: RecordLink,
) {
  if (!viewer || !isRemovableLinkOrigin(link.origin)) return false;
  const other = otherEnd(viewer, link);
  return link.direction === 'out' ? canLinkRecords(viewer, thisEnd, other) : canLinkRecords(viewer, other, thisEnd);
}

function Group({
  group,
  links,
  canRemove,
  onRemove,
}: {
  group: LinkGroup;
  links: RecordLink[];
  canRemove: (link: RecordLink) => boolean;
  onRemove: (target: RemovalTarget) => void;
}) {
  const titleId = useId();
  const rows = links
    .map((link) => ({ link, way: wayOf(group, link) }))
    .filter((row): row is { link: RecordLink; way: LinkWay } => row.way !== undefined)
    .sort((a, b) => a.link.other.number.localeCompare(b.link.other.number));
  const actions = rows.some(({ link }) => canRemove(link));

  return (
    <section aria-labelledby={titleId} className="border-t first:border-t-0">
      <h3 id={titleId} className="bg-muted/60 px-5 py-2 text-[13px] font-semibold">
        {group.title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-5 py-3 text-sm">Nothing linked yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground">
              {group.twoWay ? <TableHead className="w-32 pl-5">Link</TableHead> : null}
              <TableHead className={group.twoWay ? 'w-32' : 'w-32 pl-5'}>Number</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-32">Label</TableHead>
              <TableHead className={actions ? 'w-28' : 'w-28 pr-5'}>Status</TableHead>
              {actions ? (
                <TableHead className="w-28 pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ link, way }) => (
              <TableRow key={`${link.type}:${link.direction}:${link.other.id}`} className="hover:bg-muted/40">
                {group.twoWay ? (
                  <TableCell className="text-muted-foreground pl-5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {way.direction === 'out' ? (
                        <ArrowUpRight className="size-3.5" aria-hidden />
                      ) : (
                        <ArrowDownLeft className="size-3.5" aria-hidden />
                      )}
                      {way.title}
                    </span>{' '}
                  </TableCell>
                ) : null}
                <TableCell className={group.twoWay ? undefined : 'pl-5'}>
                  <RecordNumberLink kind={link.other.kind} id={link.other.id} number={link.other.number} />
                </TableCell>
                <TableCell className="max-w-0 truncate" title={link.other.name}>
                  {link.other.name}
                </TableCell>
                <TableCell>
                  {isLabel(link.other.label) ? <LabelBadge label={link.other.label as Label} /> : link.other.label}
                </TableCell>
                <TableCell className={actions ? undefined : 'pr-5'}>
                  <StatusBadge status={link.other.status} />
                </TableCell>
                {actions ? (
                  <TableCell className="py-1 pr-3 text-right">
                    {canRemove(link) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive h-7"
                        aria-label={`Remove link to ${link.other.number}`}
                        onClick={() => onRemove({ groupTitle: group.title, link })}
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
      )}
    </section>
  );
}

export function RelatedRecords({ kind, record, noun }: { kind: RecordKind; record: AnyRecord; noun: string }) {
  const me = useMe();
  const links = useRecordLinks(kind, record.id);
  const viewer = me.data ? { userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance } : null;
  const ways = viewer ? offeredWays(viewer, kind, record) : [];
  const thisEnd = { kind, label: record.label, owner: record.owner };
  const remove = useRemoveLink();
  const [target, setTarget] = useState<RemovalTarget | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ error: unknown; subject: string } | null>(null);

  const startRemoval = (next: RemovalTarget) => {
    remove.reset();
    setRemoved(null);
    setRefused(null);
    setTarget(next);
  };

  const confirmRemoval = () => {
    if (!target) return;
    const { link } = target;
    const [fromId, toId] = link.direction === 'out' ? [record.id, link.other.id] : [link.other.id, record.id];
    remove.mutate(
      {
        body: { type: link.type as PostLinksRemoveBody['type'], fromId, toId },
        ends: [
          { kind, id: record.id },
          { kind: link.other.kind, id: link.other.id },
        ],
      },
      {
        onSuccess: () => {
          setTarget(null);
          setRemoved(`Link to ${link.other.number} ${link.other.name} removed.`);
        },
        onError: (error) => {
          setTarget(null);
          setRefused({ error, subject: link.other.number });
        },
      },
    );
  };

  return (
    <div className="bg-card rounded-lg border shadow-xs">
      <div className="flex min-h-11 items-center gap-3 border-b px-5 py-1.5">
        <h2 className="text-sm font-semibold">Related records</h2>
        <p role="status" className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          {removed ? (
            <>
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              <span className="truncate">{removed}</span>
            </>
          ) : null}
        </p>
        {viewer && ways.length > 0 ? (
          <div className="ml-auto">
            <AddLinkDialog kind={kind} record={record} noun={noun} viewer={viewer} ways={ways} />
          </div>
        ) : null}
      </div>
      {refused ? (
        <div className="border-b p-4">
          <RemovalRefusal error={refused.error} subject={refused.subject} />
        </div>
      ) : null}
      {links.isPending ? (
        <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm" role="status">
          <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
          <span>Loading related records…</span>
        </div>
      ) : links.isError ? (
        <div className="p-4">
          <ApiProblem error={links.error} title="Related records couldn’t be loaded" />
        </div>
      ) : (
        linkGroups(kind).map((group) => (
          <Group
            key={group.title}
            group={group}
            links={links.data.items}
            canRemove={(link) => mayRemove(viewer, thisEnd, link)}
            onRemove={startRemoval}
          />
        ))
      )}
      <RemoveLinkDialog
        target={target}
        pending={remove.isPending}
        onConfirm={confirmRemoval}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
