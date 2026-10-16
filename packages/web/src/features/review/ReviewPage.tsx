// The Analyst review queue (S5-005, D27 screen 8), after ServiceNow's workspace lists (D2): a tab
// per finding kind with how many wait, a status filter (Waiting by default), document and record
// filters, a sort, and a paged table per tab. The screen is for the Review-queue cell's roles
// (`canViewReviewQueue`: Admin and Analyst); every other role gets the no-access screen, as it
// does when the API answers 403 (D7, D50). Admins see everything read-only; only the Analyst
// decides, on a finding's own page.
import {
  canViewReviewQueue,
  canWorkReviewQueue,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_STATUSES,
  reviewStatusText,
  type RecordKind,
  type ReviewFindingKind,
  type ReviewFindingStatus,
} from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { Eye, Lock, X } from 'lucide-react';
import { PageHeader } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { formatRole } from '@/features/auth/session';
import { useMe } from '@/features/records/useRecords';
import { cn } from '@/lib/utils';
import { FindingsTable } from './FindingsTable';
import { isShown, KIND_ICON, type NamedRecord } from './ReviewBits';
import { DocumentFilter, RecordFilter } from './ReviewFilters';
import {
  DEFAULT_KIND,
  DEFAULT_STATUS,
  isForbidden,
  useReviewCounts,
  useReviewList,
  type FindingRow,
  type ReviewSearch,
} from './useReview';
import { KIND_TAB_TEXT } from './words';

const SCREEN = SCREENS.find((s) => s.path === '/review')!;

/** The screen for a role the review queue isn't for. */
export function ReviewNoAccess({ role }: { role: string | undefined }) {
  return (
    <div className="px-8 py-8">
      <section
        aria-labelledby="review-no-access"
        className="bg-card mx-auto flex max-w-xl flex-col items-center gap-3 rounded-lg border px-8 py-12 text-center shadow-xs"
      >
        <span className="bg-muted text-muted-foreground grid size-11 place-items-center rounded-full">
          <Lock className="size-5" aria-hidden />
        </span>
        <h2 id="review-no-access" className="text-base font-semibold">
          You don’t have access to Analyst review
        </h2>
        <p className="text-muted-foreground text-sm">
          {role ? `As ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${formatRole(role)}, you` : 'You'} can’t see what the
          extraction left for review. Analysts decide these findings and Admins can follow them. If you need to, ask an
          Admin to change your role.
        </p>
      </section>
    </div>
  );
}

/** The record a row on screen names by this ID, for the record filter's chip. */
function namedOnScreen(rows: readonly FindingRow[], id: string): { number: string; name: string } | undefined {
  const pick = (record: NamedRecord | undefined) =>
    record && isShown(record) && record.recordId === id ? { number: record.number, name: record.name } : undefined;
  for (const row of rows) {
    let found: { number: string; name: string } | undefined;
    if (row.kind === 'link') {
      const { from, to } = row.summary;
      found =
        (from.state === 'matched' ? pick(from.record) : undefined) ??
        (to.state === 'matched' ? pick(to.record) : undefined);
    } else if (row.kind === 'duplicate') {
      found = pick(row.summary.kept) ?? pick(row.summary.other);
    } else if (row.kind === 'mapping') {
      found = pick(row.summary.from) ?? pick(row.summary.to);
    }
    if (found) return found;
  }
  return undefined;
}

function KindTabs({
  search,
  active,
  counts,
}: {
  search: ReviewSearch;
  active: ReviewFindingKind;
  counts: Readonly<Record<ReviewFindingKind, number>> | undefined;
}) {
  return (
    <nav aria-label="Finding kinds" className="flex overflow-x-auto border-b px-2">
      {REVIEW_FINDING_KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        const selected = kind === active;
        const next: ReviewSearch = { ...search };
        delete next.page;
        if (kind === DEFAULT_KIND) delete next.kind;
        else next.kind = kind;
        const waiting = counts?.[kind];
        return (
          <Link
            key={kind}
            to="/review"
            search={next}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'relative -mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm whitespace-nowrap outline-none',
              'focus-visible:ring-ring/50 rounded-t-sm focus-visible:ring-[3px] focus-visible:ring-inset',
              selected
                ? 'border-primary text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            <Icon className={cn('size-4', selected ? 'text-primary' : 'opacity-70')} aria-hidden />
            {KIND_TAB_TEXT[kind]}
            {waiting !== undefined ? (
              <span
                className={cn(
                  'min-w-6 rounded-full px-1.5 py-0.5 text-center text-xs leading-none font-bold tabular-nums',
                  waiting > 0 ? 'bg-[#fdf0d5] text-[#7a5410] ring-1 ring-[#e3c98f]' : 'bg-muted text-muted-foreground',
                )}
              >
                {waiting}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function ReviewPage({
  search,
  onSearchChange,
}: {
  search: ReviewSearch;
  onSearchChange: (next: ReviewSearch) => void;
}) {
  const me = useMe();
  const role = me.data?.role;
  const allowed = role !== undefined && canViewReviewQueue(role);
  const readOnly = role !== undefined && allowed && !canWorkReviewQueue(role);
  const counts = useReviewCounts(allowed);
  const list = useReviewList(search, allowed);

  const header = <PageHeader title={SCREEN.label} summary={SCREEN.summary} />;

  if (role !== undefined && (!allowed || (isForbidden(list.error) && !list.data))) {
    return (
      <>
        {header}
        <ReviewNoAccess role={role} />
      </>
    );
  }
  if (role === undefined) return header;

  const kind = search.kind ?? DEFAULT_KIND;
  const status = search.status ?? DEFAULT_STATUS;
  const filtered = search.documentId !== undefined || search.recordId !== undefined;
  const rows = list.data?.items ?? [];

  /** A change to one filter goes back to page 1; the tab stays. */
  const change = (patch: Partial<ReviewSearch>) => {
    const next: ReviewSearch = { ...search, ...patch };
    delete next.page;
    for (const key of Object.keys(next) as Array<keyof ReviewSearch>) {
      if (next[key] === undefined) delete next[key];
    }
    if (next.status === DEFAULT_STATUS) delete next.status;
    onSearchChange(next);
  };
  const clearFilters = () => change({ documentId: undefined, recordId: undefined, recordKind: undefined });

  return (
    <>
      {header}
      <div className="flex min-w-0 flex-col gap-4 px-8 py-6">
        {readOnly ? (
          <Alert variant="info" role="note">
            <Eye aria-hidden />
            <AlertDescription>
              <p>
                You can follow every finding and how it was decided, read-only. Only an Analyst approves or rejects
                them.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <section aria-label="Review findings" className="bg-card min-w-0 rounded-lg border shadow-xs">
          <KindTabs search={search} active={kind} counts={counts.data?.pending} />

          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <NativeSelect
              aria-label="Status"
              className="w-36"
              value={status}
              onChange={(event) => change({ status: event.target.value as ReviewFindingStatus })}
            >
              {REVIEW_FINDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {reviewStatusText(s)}
                </option>
              ))}
            </NativeSelect>
            <DocumentFilter documentId={search.documentId} onChange={(documentId) => change({ documentId })} />
            <RecordFilter
              recordId={search.recordId}
              recordKind={search.recordKind}
              known={search.recordId ? namedOnScreen(rows, search.recordId) : undefined}
              onChange={(record?: { id: string; kind: RecordKind }) =>
                change({ recordId: record?.id, recordKind: record?.kind })
              }
            />
            {filtered ? (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                <X aria-hidden />
                Clear
              </Button>
            ) : null}
            <NativeSelect
              aria-label="Sort"
              className="ml-auto w-40"
              value={search.sort ?? 'newest'}
              onChange={(event) => change({ sort: event.target.value === 'oldest' ? 'oldest' : undefined })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </NativeSelect>
          </div>

          <FindingsTable
            kind={kind}
            status={status}
            rows={rows}
            isPending={list.isPending}
            isPlaceholderData={list.isPlaceholderData}
            error={list.error}
            total={list.data?.total}
            page={search.page ?? 1}
            filtered={filtered}
            onClearFilters={clearFilters}
            onPage={(page) => {
              const next: ReviewSearch = { ...search, page };
              if (page <= 1) delete next.page;
              onSearchChange(next);
            }}
          />
        </section>
      </div>
    </>
  );
}
