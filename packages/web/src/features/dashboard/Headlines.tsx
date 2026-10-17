// The dashboard's headline figures (S8-009), after ServiceNow's score indicators (D2): one joined
// strip of scores, each a big number with what it counts and what to look at first, and each a link
// into its screen. A score shows only when its section is in the API's answer (D50, D51); waiting
// for review shows only for the roles that see the queue (Admin and Analyst).
import { EXPIRING_SOON_DAYS } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import {
  AlarmClock,
  CalendarClock,
  ClipboardList,
  FileSearch,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Siren,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { GetReviewCountsResponse } from '@/api/client';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { cn } from '@/lib/utils';
import { countOf, Placeholder } from './Tile';
import { LEVEL_TEXT, type Level } from './tones';
import type { Dashboard } from './useDashboard';

const CELL =
  'bg-card hover:bg-accent/45 group flex h-full min-h-[7.25rem] flex-col gap-2 px-5 py-4 transition-colors focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset';

/** Each score's share of a row: two to a row on small screens, then the strip's own column count;
 * a short last row stretches to the full width, so no row ends in an empty cell. */
const STRIP_ITEM = 'grow basis-[calc(50%-1px)] border-r border-b lg:basis-[calc(100%/var(--cols)-1px)]';

/** Up to 4 scores in one row; more split into two rows as even as they go (5 is 3 + 2, 7 is 4 + 3). */
function columnsFor(count: number): number {
  return count <= 4 ? Math.max(count, 1) : Math.ceil(count / 2);
}

function Score({
  label,
  icon: Icon,
  value,
  detail,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  detail: ReactNode;
}) {
  return (
    <>
      <span className="flex min-h-[2lh] items-start gap-2 text-xs leading-snug">
        <span className="text-muted-foreground font-semibold">{label}</span>
        <Icon
          className="text-primary/70 group-hover:text-primary ml-auto size-4 shrink-0 transition-colors"
          aria-hidden
        />
      </span>
      <span className="text-[1.875rem] leading-none font-bold tracking-tight tabular-nums">{value}</span>
      <span className="mt-auto text-xs leading-snug">{detail}</span>
    </>
  );
}

/** A count called out in its level's colour when there is any: "3 critical". */
function Callout({ n, level, children }: { n: number; level: Level; children: ReactNode }) {
  return (
    <span className={cn('tabular-nums', n > 0 ? cn('font-bold', LEVEL_TEXT[level]) : 'text-muted-foreground')}>
      {formatCount(n)} {children}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** What waits, in words: "3 links, 1 new record". */
function waitingDetail(pending: GetReviewCountsResponse['pending']): string {
  const parts = [
    pending.link > 0 ? countOf(pending.link, 'link') : null,
    pending.record > 0 ? countOf(pending.record, 'new record') : null,
    pending.duplicate > 0 ? countOf(pending.duplicate, 'possible duplicate') : null,
    pending.mapping > 0 ? countOf(pending.mapping, 'suggested mapping') : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Nothing waiting for an Analyst' : parts.join(', ');
}

export interface WaitingForReview {
  /** The person's role sees the queue. */
  shown: boolean;
  pending: boolean;
  failed: boolean;
  data: GetReviewCountsResponse | undefined;
}

export function Headlines({ dashboard, waiting }: { dashboard: Dashboard; waiting: WaitingForReview }) {
  const { risks, incidents, controls, auditFindings, evidence } = dashboard;
  const items: Array<{ key: string; node: ReactNode }> = [];

  if (risks) {
    items.push({
      key: 'high-risks',
      node: (
        <Link to="/risks" search={{ sort: '-score' }} className={CELL}>
          <Score
            label="Open high and critical risks"
            icon={ShieldAlert}
            value={formatCount(risks.byBand.critical + risks.byBand.high)}
            detail={
              <>
                <Callout n={risks.byBand.critical} level="critical">
                  critical
                </Callout>
                <Muted>, </Muted>
                <Callout n={risks.byBand.high} level="high">
                  high
                </Callout>
              </>
            }
          />
        </Link>
      ),
    });
    items.push({
      key: 'untreated',
      node: (
        <Link to="/risks" className={CELL}>
          <Score
            label="Untreated risks"
            icon={ShieldOff}
            value={formatCount(risks.untreated)}
            detail={
              risks.total === 0 ? (
                <Muted>No risks you can see</Muted>
              ) : (
                <Muted>of {countOf(risks.total, 'risk')} with no control treating them</Muted>
              )
            }
          />
        </Link>
      ),
    });
  }

  if (incidents) {
    items.push({
      key: 'incidents',
      node: (
        <Link to="/incidents" className={CELL}>
          <Score
            label="Open incidents"
            icon={Siren}
            value={formatCount(incidents.open)}
            detail={
              <>
                <Callout n={incidents.openBySeverity.critical} level="critical">
                  critical
                </Callout>
                <Muted>, </Muted>
                <Callout n={incidents.openBySeverity.high} level="high">
                  high
                </Callout>
              </>
            }
          />
        </Link>
      ),
    });
  }

  if (controls) {
    items.push({
      key: 'controls',
      node: (
        <Link to="/controls" className={CELL}>
          <Score
            label="Controls implemented"
            icon={ShieldCheck}
            value={controls.implementedShare === null ? '–' : `${Math.round(controls.implementedShare * 100)}%`}
            detail={
              controls.total === 0 ? (
                <Muted>No controls you can see</Muted>
              ) : (
                <Muted>
                  {formatCount(controls.byStatus.implemented)} of {countOf(controls.total, 'control')}
                </Muted>
              )
            }
          />
        </Link>
      ),
    });
  }

  if (auditFindings) {
    items.push({
      key: 'findings',
      node: (
        // Audit findings are read on the controls and risks they concern; they have no list of their own.
        <Link to="/controls" className={CELL}>
          <Score
            label="Open audit findings"
            icon={FileSearch}
            value={formatCount(auditFindings.open)}
            detail={
              auditFindings.overdue > 0 ? (
                <span className="inline-flex items-center gap-1 font-bold text-[#b42318]">
                  <AlarmClock className="size-3.5" aria-hidden />
                  {formatCount(auditFindings.overdue)} overdue
                </span>
              ) : (
                <Muted>None overdue</Muted>
              )
            }
          />
        </Link>
      ),
    });
  }

  if (evidence) {
    items.push({
      key: 'evidence',
      node: (
        // Evidence is kept on the controls it supports.
        <Link to="/controls" className={CELL}>
          <Score
            label="Evidence expiring soon"
            icon={CalendarClock}
            value={formatCount(evidence.expiringSoon)}
            detail={
              evidence.expired > 0 ? (
                <span className="font-bold text-[#b42318]">{formatCount(evidence.expired)} already expired</span>
              ) : (
                <Muted>Within {EXPIRING_SOON_DAYS} days, none expired</Muted>
              )
            }
          />
        </Link>
      ),
    });
  }

  if (waiting.shown) {
    items.push({
      key: 'review',
      node: (
        <Link to="/review" className={CELL}>
          <Score
            label="Waiting for review"
            icon={ClipboardList}
            value={
              waiting.data ? (
                formatCount(waiting.data.total)
              ) : waiting.pending ? (
                <Placeholder className="h-[1.875rem] w-14" />
              ) : (
                '–'
              )
            }
            detail={
              waiting.data ? (
                <Muted>{waitingDetail(waiting.data.pending)}</Muted>
              ) : waiting.failed ? (
                <Muted>Couldn’t be counted just now</Muted>
              ) : (
                <Placeholder className="h-3 w-24" />
              )
            }
          />
        </Link>
      ),
    });
  }

  if (items.length === 0) return null;

  return (
    <section aria-label="Headline figures" className="bg-card overflow-hidden rounded-lg border shadow-xs">
      <ul className="-mr-px -mb-px flex flex-wrap" style={{ '--cols': columnsFor(items.length) } as CSSProperties}>
        {items.map((item) => (
          <li key={item.key} className={STRIP_ITEM}>
            {item.node}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The strip's shape while the dashboard loads. */
export function HeadlinesPlaceholder() {
  return (
    <div aria-hidden className="bg-card overflow-hidden rounded-lg border shadow-xs">
      <div className="-mr-px -mb-px flex flex-wrap" style={{ '--cols': columnsFor(5) } as CSSProperties}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={cn(STRIP_ITEM, 'grid min-h-[7.25rem] content-start gap-3 px-5 py-4')}>
            <Placeholder className="h-3 w-28" />
            <Placeholder className="h-7 w-14" />
            <Placeholder className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
