// A record list screen (D27, screens 3–6): the screen's title and summary, its "New" action when the
// role table allows (D50, D199), a note when the role sees only its own records, a message carried
// over from the page the person came from, and the kit's table.
import { useLocation } from '@tanstack/react-router';
import { ROLE_TABLE, isRole, type RecordKind } from '@grc/shared';
import { CircleCheck, UserCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Screen } from '@/app/screens';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { canCreateRecord } from './permissions';
import { RecordTable, type ColumnDef, type FilterDef, type ListSearch } from './RecordTable';
import { useMe, type AnyRecord } from './useRecords';

/** What a page can leave for the list it returns to, in the history entry's state. */
export interface ListNotice {
  notice?: string;
}

interface Props<R extends AnyRecord> {
  kind: RecordKind;
  screen: Screen;
  /** Plural, lowercase: "controls". */
  noun: string;
  columns: ColumnDef<R>[];
  filters: readonly FilterDef[];
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
  /** The "New …" link, shown only to roles with full edit on the kind. */
  newAction: ReactNode;
  /** Shown to a role that sees only the records it owns (`edit_own`). */
  ownNote?: string;
}

export function RecordListPage<R extends AnyRecord>({
  kind,
  screen,
  noun,
  columns,
  filters,
  search,
  onSearchChange,
  newAction,
  ownNote,
}: Props<R>) {
  const me = useMe();
  const notice = useLocation({
    select: (location) => {
      const value = (location.state as ListNotice).notice;
      return typeof value === 'string' ? value : undefined;
    },
  });
  const role = me.data?.role;
  const mayCreate =
    me.data !== undefined &&
    canCreateRecord({ userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance }, kind);
  const onlyOwn = role !== undefined && isRole(role) && ROLE_TABLE[kind][role] === 'edit_own';

  return (
    <>
      <div className="bg-card flex flex-wrap items-start gap-4 border-b px-8 py-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{screen.label}</h1>
          <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">{screen.summary}</p>
        </div>
        {mayCreate ? newAction : null}
      </div>
      <div className="grid gap-4 px-8 py-6">
        {notice ? (
          <Alert variant="info" role="status">
            <CircleCheck aria-hidden />
            <AlertDescription>
              <p>{notice}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {onlyOwn && ownNote ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <UserCheck className="text-primary size-4 shrink-0" aria-hidden />
            {ownNote}
          </p>
        ) : null}
        <RecordTable<R>
          kind={kind}
          noun={noun}
          columns={columns}
          filters={filters}
          search={search}
          onSearchChange={onSearchChange}
          emptyText={screen.empty}
        />
      </div>
    </>
  );
}
