// A record's sensitivity label (D51), as a small badge. The two labels that limit who can see a
// record carry a lock.
import type { Label } from '@grc/shared';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { words } from './format';

const TONE: Record<Label, string> = {
  public: 'border-[#b9d3c4] bg-[#eef6f1] text-[#23553a]',
  internal: 'border-[#c6d2d8] bg-[#f1f4f6] text-[#34474f]',
  confidential: 'border-[#e3c98f] bg-[#fdf6e5] text-[#7a5410]',
  restricted: 'border-[#e2b0ab] bg-[#fcefed] text-[#8f1f15]',
};

export function LabelBadge({ label, className }: { label: Label; className?: string }) {
  const locked = label === 'confidential' || label === 'restricted';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs leading-none font-semibold whitespace-nowrap',
        TONE[label],
        className,
      )}
    >
      {locked ? <Lock className="size-3" aria-hidden /> : null}
      <span>{words(label)}</span>
    </span>
  );
}
