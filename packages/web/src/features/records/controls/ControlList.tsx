// Controls (D27, screen 3): every control with its code, framework, status, owner and last test,
// paged, sorted and filtered by the API (D47). A Control Owner sees only their own (D50, D199).
import { Link } from '@tanstack/react-router';
import { CONTROL_STATUSES } from '@grc/shared';
import { Plus } from 'lucide-react';
import { SCREENS } from '@/app/screens';
import { buttonVariants } from '@/components/ui/button';
import { choices, formatDate } from '../format';
import { RecordListPage } from '../RecordListPage';
import {
  nameColumn,
  numberColumn,
  ownerColumn,
  validateListSearch,
  type ColumnDef,
  type FilterDef,
  type ListSearch,
} from '../RecordTable';
import { ValueBadge } from '../ValueBadge';
import type { Control } from './ControlPage';

const SCREEN = SCREENS.find((s) => s.path === '/controls')!;

export const CONTROL_FILTERS: readonly FilterDef[] = [
  { key: 'controlStatus', label: 'Control status', anyText: 'Any status', options: choices(CONTROL_STATUSES) },
  { key: 'framework', label: 'Framework', anyText: 'Framework' },
];

export function validateControlSearch(raw: Record<string, unknown>): ListSearch {
  return validateListSearch(raw, { filters: CONTROL_FILTERS, sorts: ['number', 'name', 'updatedAt'] });
}

const COLUMNS: ColumnDef<Control>[] = [
  numberColumn<Control>((control) => (
    <Link
      to="/controls/$id"
      params={{ id: control.id }}
      className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
    >
      {control.number}
    </Link>
  )),
  {
    id: 'code',
    header: 'Code',
    cell: ({ record }) => <span className="font-medium whitespace-nowrap">{record.code}</span>,
  },
  nameColumn<Control>(),
  {
    id: 'framework',
    header: 'Framework',
    cell: ({ record }) => <span className="whitespace-nowrap">{record.framework}</span>,
  },
  { id: 'controlStatus', header: 'Control status', cell: ({ record }) => <ValueBadge value={record.controlStatus} /> },
  ownerColumn<Control>(),
  {
    id: 'lastTested',
    header: 'Last tested',
    cell: ({ record }) => <span className="whitespace-nowrap">{formatDate(record.lastTestedDate)}</span>,
  },
];

export function ControlList({
  search,
  onSearchChange,
}: {
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
}) {
  return (
    <RecordListPage<Control>
      kind="control"
      screen={SCREEN}
      noun="controls"
      columns={COLUMNS}
      filters={CONTROL_FILTERS}
      search={search}
      onSearchChange={onSearchChange}
      ownNote="This list shows only the controls you own. You can edit them and hand them to another owner."
      newAction={
        <Link to="/controls/new" className={buttonVariants()}>
          <Plus aria-hidden />
          New control
        </Link>
      }
    />
  );
}
