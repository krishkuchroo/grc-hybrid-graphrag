// The result list of the two mapping pickers ("Map a control" and "Add requirement"): what the
// search found, one row per item. An item already mapped shows as mapped and can't be picked again;
// the API would refuse it anyway (409 `link_exists`).
import { Check, CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiProblem } from '@/features/records/ApiProblem';
import { cn } from '@/lib/utils';

export interface PickerItem {
  id: string;
  /** The item's number or code, set in bold. */
  lead: string;
  /** Its name or title. */
  text: string;
  /** Shown at the end of the row, for example the control's label. */
  trailing?: ReactNode;
  mapped: boolean;
}

export function PickerResults({
  prompt,
  searching,
  error,
  errorTitle,
  emptyText,
  listLabel,
  items,
  pickedId,
  onPick,
}: {
  /** Shown instead of results while there's nothing to search yet. */
  prompt: string | null;
  searching: boolean;
  error: unknown;
  errorTitle: string;
  emptyText: string;
  listLabel: string;
  items: PickerItem[];
  pickedId: string | null;
  onPick: (id: string) => void;
}) {
  let body: ReactNode;
  if (prompt !== null) {
    body = <p className="text-muted-foreground px-4 py-6 text-center text-sm">{prompt}</p>;
  } else if (error) {
    body = (
      <div className="p-3">
        <ApiProblem error={error} title={errorTitle} />
      </div>
    );
  } else if (searching) {
    body = (
      <p className="text-muted-foreground px-4 py-6 text-center text-sm" role="status">
        Searching…
      </p>
    );
  } else if (items.length === 0) {
    body = <p className="text-muted-foreground px-4 py-6 text-center text-sm">{emptyText}</p>;
  } else {
    body = (
      <ul aria-label={listLabel} className="max-h-64 divide-y overflow-y-auto">
        {items.map((item) => {
          const selected = !item.mapped && pickedId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={item.mapped}
                aria-pressed={selected}
                onClick={() => onPick(item.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none',
                  'hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:ring-inset',
                  selected && 'bg-primary/10 hover:bg-primary/10',
                  item.mapped && 'text-muted-foreground cursor-not-allowed hover:bg-transparent',
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                  {selected ? <Check className="text-primary size-4" /> : null}
                </span>
                <span className="w-24 shrink-0 font-semibold tabular-nums">{item.lead}</span>{' '}
                <span className="min-w-0 flex-1 truncate" title={item.text}>
                  {item.text}
                </span>{' '}
                {item.mapped ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[#1f5c38]">
                    <CircleCheck className="size-3.5" aria-hidden />
                    Mapped
                  </span>
                ) : (
                  item.trailing
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return <div className="bg-muted/30 min-h-32 rounded-md border">{body}</div>;
}
