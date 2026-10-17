// The dashboard's building blocks (S8-009), in the app's ServiceNow look (D2): a white tile with a
// titled header and a way into its screen, a short empty state, and the loading placeholders.
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { cn } from '@/lib/utils';

/** A count and its noun: `1 risk`, `12 risks`. */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** The look of a tile header's link into its screen (a TanStack `Link` the caller renders). */
export const TILE_LINK =
  'text-primary inline-flex items-center gap-0.5 rounded-sm text-xs font-semibold whitespace-nowrap hover:underline focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none [&_svg]:size-3.5';

export function Tile({
  id,
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  /** The heading's id, which names the tile for screen readers. */
  id: string;
  title: string;
  /** The link into the tile's screen, shown at the header's right. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn('bg-card flex min-w-0 flex-col rounded-lg border shadow-xs', className)}
    >
      <header className="flex min-h-11 items-center gap-3 border-b px-5 py-2.5">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      <div className={cn('flex-1 px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** What a tile with nothing to show says: a quiet icon and one line. */
export function TileEmpty({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center gap-2 py-4 text-center">
      <span className="bg-muted text-muted-foreground grid size-9 place-items-center rounded-full">
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="text-muted-foreground text-sm">{children}</p>
    </div>
  );
}

/** One grey loading bar. */
export function Placeholder({ className }: { className?: string }) {
  return <span aria-hidden className={cn('bg-muted block animate-pulse rounded-sm', className)} />;
}

/** A tile's shape while the dashboard loads. */
export function TilePlaceholder({ className, rows = 4 }: { className?: string; rows?: number }) {
  return (
    <div aria-hidden className={cn('bg-card flex min-w-0 flex-col rounded-lg border shadow-xs', className)}>
      <div className="flex min-h-11 items-center border-b px-5 py-2.5">
        <Placeholder className="h-3.5 w-32" />
      </div>
      <div className="grid gap-3 px-5 py-4">
        {Array.from({ length: rows }, (_, i) => (
          <Placeholder key={i} className={cn('h-4', i % 3 === 0 ? 'w-full' : i % 3 === 1 ? 'w-4/5' : 'w-3/5')} />
        ))}
      </div>
    </div>
  );
}
