// Evidence validity at a glance (D213 (2)), from the API's `validity`: Valid, Expiring soon (the
// valid-until date is within 30 days) or Expired. An icon and the words go with each colour, so
// colour is never the only cue.
import { Hourglass, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';
import type { EvidenceValidity } from '@grc/shared';
import { cn } from '@/lib/utils';
import { validityText } from './useEvidence';

const LOOK: Record<EvidenceValidity, { icon: LucideIcon; tone: string }> = {
  valid: { icon: ShieldCheck, tone: 'border-[#b9d3c4] bg-[#eef6f1] text-[#23553a]' },
  expiring: { icon: Hourglass, tone: 'border-[#e8c873] bg-[#fdf5df] text-[#7a5410]' },
  expired: { icon: ShieldX, tone: 'border-[#e2b0ab] bg-[#fcefed] text-[#8f1f15]' },
};

export function ValidityBadge({ validity, className }: { validity: string; className?: string }) {
  const look = LOOK[validity as EvidenceValidity] ?? LOOK.expired;
  const Icon = look.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap',
        look.tone,
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span>{validityText(validity)}</span>
    </span>
  );
}
