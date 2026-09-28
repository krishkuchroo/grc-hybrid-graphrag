// A policy's page and its create page, configuring the records kit: the policy's own fields (its
// version and effective day, D197).
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { formatDate } from '../format';
import type { FormFieldDef } from '../RecordForm';
import { NewRecordPage, RecordPage } from '../RecordPage';
import type { AnyRecord } from '../useRecords';

export type Policy = AnyRecord & {
  policyVersion: string;
  effectiveDate: string;
};

export const POLICY_FORM_FIELDS: readonly FormFieldDef[] = [
  {
    name: 'policyVersion',
    label: 'Policy version',
    control: 'text',
    message: 'Enter the policy’s version, for example 1.0.',
    placeholder: 'e.g. 1.0',
  },
  {
    name: 'effectiveDate',
    label: 'Effective date',
    control: 'date',
    message: 'Enter the day the policy takes effect.',
  },
];

function BackToPolicies() {
  return (
    <Link to="/policies" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Policies
    </Link>
  );
}

export function PolicyPage({ id }: { id: string }) {
  return (
    <RecordPage<Policy>
      kind="policy"
      id={id}
      noun="policy"
      back={<BackToPolicies />}
      details={(policy) => [
        { label: 'Policy version', value: policy.policyVersion },
        { label: 'Effective date', value: formatDate(policy.effectiveDate) },
      ]}
      formFields={POLICY_FORM_FIELDS}
      formValues={(policy) => ({ policyVersion: policy.policyVersion, effectiveDate: policy.effectiveDate })}
    />
  );
}

export function NewPolicyPage() {
  const navigate = useNavigate();
  return (
    <NewRecordPage
      kind="policy"
      noun="policy"
      back={<BackToPolicies />}
      formFields={POLICY_FORM_FIELDS}
      onCancel={() => void navigate({ to: '/policies' })}
      onCreated={(policy) => void navigate({ to: '/policies/$id', params: { id: policy.id } })}
    />
  );
}
