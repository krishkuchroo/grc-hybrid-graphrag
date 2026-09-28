// Assets (D27, screen 5): every system, application and data store with its type, criticality,
// data classification and owner, paged, sorted and filtered by the API (D47).
import { Link } from '@tanstack/react-router';
import { ASSET_TYPES, CRITICALITIES, type Label } from '@grc/shared';
import { Plus } from 'lucide-react';
import { SCREENS } from '@/app/screens';
import { buttonVariants } from '@/components/ui/button';
import { choices, words } from '../format';
import { LabelBadge } from '../LabelBadge';
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
import type { Asset } from './AssetPage';

const SCREEN = SCREENS.find((s) => s.path === '/assets')!;

export const ASSET_FILTERS: readonly FilterDef[] = [
  { key: 'assetType', label: 'Asset type', anyText: 'Any type', options: choices(ASSET_TYPES) },
  { key: 'criticality', label: 'Criticality', anyText: 'Any criticality', options: choices(CRITICALITIES) },
];

export function validateAssetSearch(raw: Record<string, unknown>): ListSearch {
  return validateListSearch(raw, { filters: ASSET_FILTERS, sorts: ['number', 'name', 'updatedAt'] });
}

const COLUMNS: ColumnDef<Asset>[] = [
  numberColumn<Asset>((asset) => (
    <Link
      to="/assets/$id"
      params={{ id: asset.id }}
      className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
    >
      {asset.number}
    </Link>
  )),
  nameColumn<Asset>(),
  {
    id: 'assetType',
    header: 'Asset type',
    cell: ({ record }) => <span className="whitespace-nowrap">{words(record.assetType)}</span>,
  },
  { id: 'criticality', header: 'Criticality', cell: ({ record }) => <ValueBadge value={record.criticality} /> },
  {
    id: 'dataClassification',
    header: 'Data classification',
    cell: ({ record }) => <LabelBadge label={record.dataClassification as Label} />,
  },
  ownerColumn<Asset>(),
];

export function AssetList({
  search,
  onSearchChange,
}: {
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
}) {
  return (
    <RecordListPage<Asset>
      kind="asset"
      screen={SCREEN}
      noun="assets"
      columns={COLUMNS}
      filters={ASSET_FILTERS}
      search={search}
      onSearchChange={onSearchChange}
      newAction={
        <Link to="/assets/new" className={buttonVariants()}>
          <Plus aria-hidden />
          New asset
        </Link>
      }
    />
  );
}
