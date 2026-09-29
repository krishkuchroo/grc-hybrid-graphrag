// A risk's page and its create page, configuring the records kit: the risk's own fields (impact,
// likelihood, financial exposure, D197) and its rating panel.
import { Link, useNavigate } from '@tanstack/react-router';
import { RISK_SCALE } from '@grc/shared';
import { ChevronLeft } from 'lucide-react';
import { formatDollars } from '../format';
import type { FormFieldDef } from '../RecordForm';
import { RelatedRecords } from '../links/RelatedRecords';
import { NewRecordPage, RecordPage } from '../RecordPage';
import type { AnyRecord } from '../useRecords';
import { RatingBadge } from './RatingBadge';

export type Risk = AnyRecord & {
  impact: number;
  likelihood: number;
  financialExposure: number;
  rating: { score: number; band: string };
};

const SCALE = RISK_SCALE.map((n) => ({ value: String(n), label: String(n) }));

export const RISK_FORM_FIELDS: readonly FormFieldDef[] = [
  {
    name: 'impact',
    label: 'Impact',
    control: 'select',
    integer: true,
    options: SCALE,
    message: 'Choose an impact from 1 to 5.',
    description: 'How bad it would be, from 1 (minor) to 5 (severe).',
  },
  {
    name: 'likelihood',
    label: 'Likelihood',
    control: 'select',
    integer: true,
    options: SCALE,
    message: 'Choose a likelihood from 1 to 5.',
    description: 'How likely it is, from 1 (rare) to 5 (almost certain).',
  },
  {
    name: 'financialExposure',
    label: 'Financial exposure',
    control: 'integer',
    message: 'Enter a whole number of dollars, 0 or more, without cents.',
    description: 'In US dollars, whole dollars only.',
    placeholder: 'e.g. 250000',
  },
];

function BackToRegister() {
  return (
    <Link to="/risks" className="hover:text-primary inline-flex items-center gap-1 font-semibold">
      <ChevronLeft className="size-3.5" aria-hidden />
      Risk register
    </Link>
  );
}

function RatingPanel({ risk }: { risk: Risk }) {
  return (
    <section aria-label="Rating" className="bg-card rounded-lg border shadow-xs">
      <h2 className="border-b px-5 py-2.5 text-sm font-semibold">Rating</h2>
      <div className="grid gap-3 px-5 py-4">
        <RatingBadge score={risk.rating.score} band={risk.rating.band} size="lg" />
        <p className="text-muted-foreground text-xs">
          Impact {risk.impact} × likelihood {risk.likelihood}
        </p>
      </div>
    </section>
  );
}

export function RiskPage({ id }: { id: string }) {
  return (
    <RecordPage<Risk>
      kind="risk"
      id={id}
      noun="risk"
      back={<BackToRegister />}
      summary={(risk) => <RatingPanel risk={risk} />}
      related={(risk) => <RelatedRecords kind="risk" noun="risk" record={risk} />}
      details={(risk) => [
        { label: 'Impact', value: risk.impact },
        { label: 'Likelihood', value: risk.likelihood },
        { label: 'Rating', value: <RatingBadge score={risk.rating.score} band={risk.rating.band} /> },
        { label: 'Financial exposure', value: formatDollars(risk.financialExposure) },
      ]}
      formFields={RISK_FORM_FIELDS}
      formValues={(risk) => ({
        impact: String(risk.impact),
        likelihood: String(risk.likelihood),
        financialExposure: String(risk.financialExposure),
      })}
    />
  );
}

export function NewRiskPage() {
  const navigate = useNavigate();
  return (
    <NewRecordPage
      kind="risk"
      noun="risk"
      back={<BackToRegister />}
      formFields={RISK_FORM_FIELDS}
      onCancel={() => void navigate({ to: '/risks' })}
      onCreated={(risk) => void navigate({ to: '/risks/$id', params: { id: risk.id } })}
    />
  );
}
