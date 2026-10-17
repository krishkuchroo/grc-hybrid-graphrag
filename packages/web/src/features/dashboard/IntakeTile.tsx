// Data intake on Home (S8-009), for the roles with the uploads cell (the API sends the documents
// section only to them): the stored documents the person can see, per processing status, as one
// proportion bar and a row per status, each opening Data intake filtered to that status.
import { DOCUMENT_STATUSES } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Inbox } from 'lucide-react';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { documentStatusText } from '@/features/intake/StatusBadge';
import { cn } from '@/lib/utils';
import { Tile, TILE_LINK, TileEmpty } from './Tile';
import { DOCUMENT_STATUS_COLOR } from './tones';
import type { DashboardDocuments } from './useDashboard';

export function IntakeTile({ documents }: { documents: DashboardDocuments }) {
  const { total, byStatus } = documents;
  return (
    <Tile
      id="dash-intake"
      title="Data intake"
      action={
        <Link to="/intake" className={TILE_LINK}>
          All uploads
          <ChevronRight aria-hidden />
        </Link>
      }
    >
      {total === 0 ? (
        <TileEmpty icon={Inbox}>No documents uploaded yet</TileEmpty>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm">
            <span className="text-2xl font-bold tabular-nums">{formatCount(total)}</span>{' '}
            <span className="text-muted-foreground">{total === 1 ? 'document' : 'documents'}</span>
          </p>
          <div aria-hidden className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
            {DOCUMENT_STATUSES.map((status) =>
              byStatus[status] > 0 ? (
                <span
                  key={status}
                  className="h-full"
                  style={{
                    width: `${(byStatus[status] / total) * 100}%`,
                    backgroundColor: DOCUMENT_STATUS_COLOR[status],
                  }}
                />
              ) : null,
            )}
          </div>
          <ul className="-mx-2 grid gap-0.5 text-sm">
            {DOCUMENT_STATUSES.map((status) => (
              <li key={status}>
                <Link
                  to="/intake"
                  search={{ status }}
                  className="hover:bg-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: DOCUMENT_STATUS_COLOR[status] }}
                  />
                  <span className={cn('flex-1', status === 'removed' && 'text-muted-foreground')}>
                    {documentStatusText(status)}
                  </span>
                  <span className={cn('font-semibold tabular-nums', byStatus[status] === 0 && 'text-muted-foreground')}>
                    {formatCount(byStatus[status])}
                    <span className="sr-only"> {byStatus[status] === 1 ? 'document' : 'documents'}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Tile>
  );
}
