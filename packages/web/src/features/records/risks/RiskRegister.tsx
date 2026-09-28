// The Risk register (D27, screen 2): every risk with its owner and rating, paged, sorted and
// filtered by the API (D47), with the filters in the address.
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { SCREENS } from '@/app/screens';
import { buttonVariants } from '@/components/ui/button';
import { canCreateRecord } from '../permissions';
import {
  labelColumn,
  nameColumn,
  numberColumn,
  ownerColumn,
  RecordTable,
  updatedColumn,
  validateListSearch,
  type ColumnDef,
  type FilterDef,
  type ListSearch,
} from '../RecordTable';
import { useMe } from '../useRecords';
import { RatingBadge } from './RatingBadge';
import type { Risk } from './RiskPage';

const SCREEN = SCREENS.find((s) => s.path === '/risks')!;

export const RISK_FILTERS: readonly FilterDef[] = [
  {
    key: 'band',
    label: 'Band',
    anyText: 'Any band',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'critical', label: 'Critical' },
    ],
  },
];

const RISK_SORTS = ['number', 'name', 'updatedAt', 'score'] as const;

export function validateRiskSearch(raw: Record<string, unknown>): ListSearch {
  return validateListSearch(raw, { filters: RISK_FILTERS, sorts: RISK_SORTS });
}

const COLUMNS: ColumnDef<Risk>[] = [
  numberColumn<Risk>((risk) => (
    <Link
      to="/risks/$id"
      params={{ id: risk.id }}
      className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
    >
      {risk.number}
    </Link>
  )),
  nameColumn<Risk>(),
  ownerColumn<Risk>(),
  { id: 'impact', header: 'Impact', numeric: true, cell: ({ record }) => record.impact },
  { id: 'likelihood', header: 'Likelihood', numeric: true, cell: ({ record }) => record.likelihood },
  {
    id: 'rating',
    header: 'Rating',
    sortKey: 'score',
    firstSort: 'desc',
    cell: ({ record }) => <RatingBadge score={record.rating.score} band={record.rating.band} />,
  },
  labelColumn<Risk>(),
  updatedColumn<Risk>(),
];

export function RiskRegister({
  search,
  onSearchChange,
}: {
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
}) {
  const me = useMe();
  const mayCreate =
    me.data !== undefined &&
    canCreateRecord({ userId: me.data.user.id, role: me.data.role, clearance: me.data.clearance }, 'risk');

  return (
    <>
      <div className="bg-card flex flex-wrap items-start gap-4 border-b px-8 py-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{SCREEN.label}</h1>
          <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">{SCREEN.summary}</p>
        </div>
        {mayCreate ? (
          <Link to="/risks/new" className={buttonVariants()}>
            <Plus aria-hidden />
            New risk
          </Link>
        ) : null}
      </div>
      <div className="px-8 py-6">
        <RecordTable<Risk>
          kind="risk"
          noun="risks"
          columns={COLUMNS}
          filters={RISK_FILTERS}
          search={search}
          onSearchChange={onSearchChange}
          emptyText={SCREEN.empty}
        />
      </div>
    </>
  );
}
