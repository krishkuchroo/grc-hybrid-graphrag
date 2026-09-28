// An incident's page and its create page, configuring the records kit: the incident's own fields
// (severity, status and when it occurred, D197). The moment is entered in the person's own time and
// sent to the API in UTC.
import { Link, useNavigate } from '@tanstack/react-router';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@grc/shared';
import { ChevronLeft } from 'lucide-react';
import { choices, formatMoment } from '../format';
import { toLocalDateTime, type FormFieldDef } from '../RecordForm';
import { NewRecordPage, RecordPage } from '../RecordPage';
import type { AnyRecord } from '../useRecords';
import { ValueBadge } from '../ValueBadge';

export type Incident = AnyRecord & {
  severity: string;
  incidentStatus: string;
  occurredAt: string;
};

export const INCIDENT_FORM_FIELDS: readonly FormFieldDef[] = [
  {
    name: 'severity',
    label: 'Severity',
    control: 'select',
    options: choices(INCIDENT_SEVERITIES),
    message: 'Choose a severity.',
  },
  {
    name: 'incidentStatus',
    label: 'Incident status',
    control: 'select',
    options: choices(INCIDENT_STATUSES),
    message: 'Choose a status.',
  },
  {
    name: 'occurredAt',
    label: 'Occurred at',
    control: 'datetime',
    message: 'Enter the day and time the incident happened.',
    description: 'In your own time zone.',
  },
];

function BackToIncidents() {
  return (
    <Link to="/incidents" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Incidents
    </Link>
  );
}

export function IncidentPage({ id }: { id: string }) {
  return (
    <RecordPage<Incident>
      kind="incident"
      id={id}
      noun="incident"
      back={<BackToIncidents />}
      details={(incident) => [
        { label: 'Severity', value: <ValueBadge value={incident.severity} /> },
        { label: 'Incident status', value: <ValueBadge value={incident.incidentStatus} /> },
        { label: 'Occurred at', value: formatMoment(incident.occurredAt) },
      ]}
      formFields={INCIDENT_FORM_FIELDS}
      formValues={(incident) => ({
        severity: incident.severity,
        incidentStatus: incident.incidentStatus,
        occurredAt: toLocalDateTime(incident.occurredAt),
      })}
    />
  );
}

export function NewIncidentPage() {
  const navigate = useNavigate();
  return (
    <NewRecordPage
      kind="incident"
      noun="incident"
      back={<BackToIncidents />}
      formFields={INCIDENT_FORM_FIELDS}
      onCancel={() => void navigate({ to: '/incidents' })}
      onCreated={(incident) => void navigate({ to: '/incidents/$id', params: { id: incident.id } })}
    />
  );
}
