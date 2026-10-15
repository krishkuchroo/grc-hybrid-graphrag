// Where a document has got to, as a ServiceNow state indicator (D2): a coloured dot beside the
// plain words. A document shows its own status (Stored, Processing, Processed, Failed); an asset
// list shows its import's (Reading, Needs mapping, Queued, Importing, Imported, Failed). A step that
// is moving on by itself has a pulsing dot; the words always carry the meaning.
import type { DocumentStatus, ImportStatus } from '@grc/shared';
import { cn } from '@/lib/utils';

type Tone = 'blue' | 'amber' | 'orange' | 'green' | 'red' | 'grey';

const DOT: Record<Tone, string> = {
  blue: 'bg-[#2b6cb0]',
  amber: 'bg-[#d4a017]',
  orange: 'bg-[#dd6b20]',
  green: 'bg-[#2f8a55]',
  red: 'bg-[#b42318]',
  grey: 'bg-[#8a969c]',
};

interface State {
  text: string;
  tone: Tone;
  /** Moving on by itself. */
  moving: boolean;
}

export const DOCUMENT_STATE: Readonly<Record<DocumentStatus, State>> = {
  stored: { text: 'Stored', tone: 'blue', moving: false },
  processing: { text: 'Processing', tone: 'amber', moving: true },
  processed: { text: 'Processed', tone: 'green', moving: false },
  failed: { text: 'Failed', tone: 'red', moving: false },
};

export const IMPORT_STATE: Readonly<Record<ImportStatus, State>> = {
  reading: { text: 'Reading', tone: 'blue', moving: true },
  needs_mapping: { text: 'Needs mapping', tone: 'orange', moving: false },
  queued: { text: 'Queued', tone: 'blue', moving: true },
  importing: { text: 'Importing', tone: 'amber', moving: true },
  done: { text: 'Imported', tone: 'green', moving: false },
  failed: { text: 'Failed', tone: 'red', moving: false },
};

/** The words for a document's status. */
export function documentStatusText(status: DocumentStatus): string {
  return DOCUMENT_STATE[status]?.text ?? status;
}

export function StatusBadge(
  props: ({ documentStatus: DocumentStatus } | { importStatus: ImportStatus }) & { className?: string },
) {
  const state = 'importStatus' in props ? IMPORT_STATE[props.importStatus] : DOCUMENT_STATE[props.documentStatus];
  const shown: State = state ?? { text: 'Unknown', tone: 'grey', moving: false };
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm whitespace-nowrap', props.className)}
      data-status={'importStatus' in props ? props.importStatus : props.documentStatus}
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        {shown.moving ? (
          <span
            className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', DOT[shown.tone])}
          />
        ) : null}
        <span className={cn('relative inline-flex size-2 rounded-full', DOT[shown.tone])} />
      </span>
      <span>{shown.text}</span>
    </span>
  );
}
