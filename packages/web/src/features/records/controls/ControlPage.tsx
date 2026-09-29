// A control's page and its create page, configuring the records kit: the control's own fields (code,
// framework, status, last tested; D197). A Control Owner who hands their control to someone else
// (D206) goes back to the Controls list with a message, since the control is no longer theirs.
import { Link, useNavigate, type HistoryState } from '@tanstack/react-router';
import { CONTROL_STATUSES } from '@grc/shared';
import { ChevronLeft } from 'lucide-react';
import { choices, formatDate } from '../format';
import type { FormFieldDef } from '../RecordForm';
import { RelatedRecords } from '../links/RelatedRecords';
import { NewRecordPage, RecordPage } from '../RecordPage';
import type { ListNotice } from '../RecordListPage';
import type { AnyRecord } from '../useRecords';
import { ValueBadge } from '../ValueBadge';

export type Control = AnyRecord & {
  code: string;
  framework: string;
  controlStatus: string;
  lastTestedDate: string;
};

export const CONTROL_FORM_FIELDS: readonly FormFieldDef[] = [
  {
    name: 'code',
    label: 'Code',
    control: 'text',
    message: 'Enter the control’s code, for example AC-2.',
    placeholder: 'e.g. AC-2',
  },
  {
    name: 'framework',
    label: 'Framework',
    control: 'text',
    message: 'Enter the framework the code comes from.',
    placeholder: 'e.g. NIST 800-53',
  },
  {
    name: 'controlStatus',
    label: 'Control status',
    control: 'select',
    options: choices(CONTROL_STATUSES),
    message: 'Choose a status.',
  },
  {
    name: 'lastTestedDate',
    label: 'Last tested',
    control: 'date',
    message: 'Enter the day the control was last tested.',
  },
];

function BackToControls() {
  return (
    <Link to="/controls" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Controls
    </Link>
  );
}

export function ControlPage({ id }: { id: string }) {
  const navigate = useNavigate();
  return (
    <RecordPage<Control>
      kind="control"
      id={id}
      noun="control"
      back={<BackToControls />}
      related={(control) => <RelatedRecords kind="control" noun="control" record={control} />}
      details={(control) => [
        { label: 'Code', value: control.code },
        { label: 'Framework', value: control.framework },
        { label: 'Control status', value: <ValueBadge value={control.controlStatus} /> },
        { label: 'Last tested', value: formatDate(control.lastTestedDate) },
      ]}
      formFields={CONTROL_FORM_FIELDS}
      formValues={(control) => ({
        code: control.code,
        framework: control.framework,
        controlStatus: control.controlStatus,
        lastTestedDate: control.lastTestedDate,
      })}
      onHandedOver={(control, ownerName) => {
        const notice: ListNotice = {
          notice: `${control.number} is now owned by ${ownerName}, so it no longer shows in your list.`,
        };
        void navigate({ to: '/controls', state: notice as HistoryState });
      }}
    />
  );
}

export function NewControlPage() {
  const navigate = useNavigate();
  return (
    <NewRecordPage
      kind="control"
      noun="control"
      back={<BackToControls />}
      formFields={CONTROL_FORM_FIELDS}
      onCancel={() => void navigate({ to: '/controls' })}
      onCreated={(control) => void navigate({ to: '/controls/$id', params: { id: control.id } })}
    />
  );
}
