// An asset's page and its create page, configuring the records kit: the asset's own fields (type,
// criticality and the classification of the data it holds, D197).
import { Link, useNavigate } from '@tanstack/react-router';
import { ASSET_TYPES, CRITICALITIES, LABELS, type Label } from '@grc/shared';
import { ChevronLeft } from 'lucide-react';
import { choices, words } from '../format';
import { LabelBadge } from '../LabelBadge';
import type { FormFieldDef } from '../RecordForm';
import { RelatedRecords } from '../links/RelatedRecords';
import { NewRecordPage, RecordPage } from '../RecordPage';
import type { AnyRecord } from '../useRecords';
import { ValueBadge } from '../ValueBadge';

export type Asset = AnyRecord & {
  assetType: string;
  criticality: string;
  dataClassification: string;
};

export const ASSET_FORM_FIELDS: readonly FormFieldDef[] = [
  {
    name: 'assetType',
    label: 'Asset type',
    control: 'select',
    options: choices(ASSET_TYPES),
    message: 'Choose an asset type.',
  },
  {
    name: 'criticality',
    label: 'Criticality',
    control: 'select',
    options: choices(CRITICALITIES),
    message: 'Choose how critical the asset is.',
    description: 'How much the business depends on it.',
  },
  {
    name: 'dataClassification',
    label: 'Data classification',
    control: 'select',
    options: choices(LABELS),
    message: 'Choose the classification of the data it holds.',
    description: 'The most sensitive data the asset holds.',
  },
];

function BackToAssets() {
  return (
    <Link to="/assets" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Assets
    </Link>
  );
}

export function AssetPage({ id }: { id: string }) {
  return (
    <RecordPage<Asset>
      kind="asset"
      id={id}
      noun="asset"
      back={<BackToAssets />}
      related={(asset) => <RelatedRecords kind="asset" noun="asset" record={asset} />}
      details={(asset) => [
        { label: 'Asset type', value: words(asset.assetType) },
        { label: 'Criticality', value: <ValueBadge value={asset.criticality} /> },
        { label: 'Data classification', value: <LabelBadge label={asset.dataClassification as Label} /> },
      ]}
      formFields={ASSET_FORM_FIELDS}
      formValues={(asset) => ({
        assetType: asset.assetType,
        criticality: asset.criticality,
        dataClassification: asset.dataClassification,
      })}
    />
  );
}

export function NewAssetPage() {
  const navigate = useNavigate();
  return (
    <NewRecordPage
      kind="asset"
      noun="asset"
      back={<BackToAssets />}
      formFields={ASSET_FORM_FIELDS}
      onCancel={() => void navigate({ to: '/assets' })}
      onCreated={(asset) => void navigate({ to: '/assets/$id', params: { id: asset.id } })}
    />
  );
}
