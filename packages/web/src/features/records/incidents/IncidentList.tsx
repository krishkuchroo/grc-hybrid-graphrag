// Incidents (D27, screen 6): every security incident with its severity, status and when it
// occurred, paged, sorted and filtered by the API (D47). A role with no access to incidents (D50)
// gets the API's 403 in the kit's "you don't have access" state; the nav item stays.
import { Link } from '@tanstack/react-router';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@grc/shared';
import { Plus } from 'lucide-react';
import { SCREENS } from '@/app/screens';
import { buttonVariants } from '@/components/ui/button';
import { choices, formatMoment } from '../format';
import { RecordListPage } from '../RecordListPage';
import {
  nameColumn,
  numberColumn,
  validateListSearch,
  type ColumnDef,
  type FilterDef,
  type ListSearch,
} from '../RecordTable';
import { ValueBadge } from '../ValueBadge';
import type { Incident } from './IncidentPage';

const SCREEN = SCREENS.find((s) => s.path === '/incidents')!;

export const INCIDENT_FILTERS: readonly FilterDef[] = [
  { key: 'severity', label: 'Severity', anyText: 'Any severity', options: choices(INCIDENT_SEVERITIES) },
  { key: 'incidentStatus', label: 'Incident status', anyText: 'Any status', options: choices(INCIDENT_STATUSES) },
];

export function validateIncidentSearch(raw: Record<string, unknown>): ListSearch {
  return validateListSearch(raw, { filters: INCIDENT_FILTERS, sorts: ['number', 'name', 'updatedAt'] });
}

const COLUMNS: ColumnDef<Incident>[] = [
  numberColumn<Incident>((incident) => (
    <Link
      to="/incidents/$id"
      params={{ id: incident.id }}
      className="text-primary font-semibold whitespace-nowrap tabular-nums hover:underline"
    >
      {incident.number}
    </Link>
  )),
  nameColumn<Incident>(),
  { id: 'severity', header: 'Severity', cell: ({ record }) => <ValueBadge value={record.severity} /> },
  {
    id: 'incidentStatus',
    header: 'Incident status',
    cell: ({ record }) => <ValueBadge value={record.incidentStatus} />,
  },
  {
    id: 'occurredAt',
    header: 'Occurred at',
    cell: ({ record }) => <span className="whitespace-nowrap">{formatMoment(record.occurredAt)}</span>,
  },
];

export function IncidentList({
  search,
  onSearchChange,
}: {
  search: ListSearch;
  onSearchChange: (next: ListSearch) => void;
}) {
  return (
    <RecordListPage<Incident>
      kind="incident"
      screen={SCREEN}
      noun="incidents"
      columns={COLUMNS}
      filters={INCIDENT_FILTERS}
      search={search}
      onSearchChange={onSearchChange}
      newAction={
        <Link to="/incidents/new" className={buttonVariants()}>
          <Plus aria-hidden />
          New incident
        </Link>
      }
    />
  );
}
