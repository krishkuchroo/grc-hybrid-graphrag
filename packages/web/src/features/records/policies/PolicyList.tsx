// Policies (D27, screen 4): every policy with its version, effective day and owner, paged, sorted and
// filtered by the API (D47). Policies have no filters of their own.
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { SCREENS } from '@/app/screens';
import { buttonVariants } from '@/components/ui/button';
import { formatDate } from '../format';
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
import type { Policy } from './PolicyPage';

const SCREEN = SCREENS.find((s) => s.path === '/policies')!;

export const POLICY_FILTERS: readonly FilterDef[] = [];

export function validatePolicySearch(raw: Record<string, unknown>): ListSearch {
  return validateListSearch(raw, { filters: POLICY_FILTERS, sorts: ['number', 'name', 'updatedAt'] });
}

const COLUMNS: ColumnDef<Policy>[] = [
  numberColumn<Policy>((policy) => (
    <Link
      to="/policies/$id"
      params={{ id: policy.id }}
      className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
    >
      {policy.number}
    </Link>
  )),
  nameColumn<Policy>(),
  {
    id: 'policyVersion',
    header: 'Version',
    cell: ({ record }) => <span className="whitespace-nowrap tabular-nums">{record.policyVersion}</span>,
  },
  {
    id: 'effectiveDate',
    header: 'Effective date',
    cell: ({ record }) => <span className="whitespace-nowrap">{formatDate(record.effectiveDate)}</span>,
  },
  ownerColumn<Policy>(),
];

export function PolicyList({
  search,
  onSearchChange,
}: {
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
}) {
  return (
    <RecordListPage<Policy>
      kind="policy"
      screen={SCREEN}
      noun="policies"
      columns={COLUMNS}
      filters={POLICY_FILTERS}
      search={search}
      onSearchChange={onSearchChange}
      newAction={
        <Link to="/policies/new" className={buttonVariants()}>
          <Plus aria-hidden />
          New policy
        </Link>
      }
    />
  );
}
