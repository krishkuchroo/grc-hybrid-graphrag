// The product's wordmark: a small sage tile with the letters, then the name.
import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span
        aria-hidden
        className="bg-brand text-chrome grid size-7 place-items-center rounded-[5px] text-[11px] font-black tracking-tight"
      >
        GRC
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">
        GRC <span className="text-chrome-muted font-normal">Workspace</span>
      </span>
    </div>
  );
}
