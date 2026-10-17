// `--wait` (S8-005): before anything else, wait until none of the org's documents is waiting
// (`stored`) or being processed (`processing`), so every question is asked of the whole org. Only
// the kinds the worker reads count: policy documents, SOC tickets and audit reports (asset lists
// go through imports instead, and evidence files are kept, not read). The counts are checked every
// 15 seconds and printed once a minute; after the given minutes it gives up, having started no run.
import type { DocumentStatus, UploadKind } from '@grc/shared';
import type { BenchApi } from './api-client.js';

/** The document kinds the worker reads into chunks (the API's READABLE_DOCUMENT_KINDS). */
export const PROCESSED_DOCUMENT_KINDS = [
  'policy_document',
  'soc_ticket',
  'audit_report',
] as const satisfies readonly UploadKind[];

/** The statuses that mean "not processed yet". */
export const UNPROCESSED_STATUSES = ['stored', 'processing'] as const satisfies readonly DocumentStatus[];

const CHECK_EVERY_MS = 15_000;
const PRINT_EVERY_MS = 60_000;

export interface DocumentCounts {
  waiting: number;
  processing: number;
}

/** The org's documents still waiting or being processed. */
export async function unprocessedDocuments(api: BenchApi): Promise<DocumentCounts> {
  const counts: DocumentCounts = { waiting: 0, processing: 0 };
  for (const kind of PROCESSED_DOCUMENT_KINDS) {
    counts.waiting += await api.documentCount(kind, 'stored');
    counts.processing += await api.documentCount(kind, 'processing');
  }
  return counts;
}

export interface WaitOptions {
  minutes: number;
  /** Told the counts at the first check and then once a minute, with the minutes waited so far. */
  onCounts: (counts: DocumentCounts, minutesWaited: number) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

export type WaitOutcome = { done: true; counts: DocumentCounts } | { done: false; counts: DocumentCounts };

/** Waits until the org has no document left to process, or the minutes are up. */
export async function waitForDocuments(api: BenchApi, options: WaitOptions): Promise<WaitOutcome> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const deadline = started + options.minutes * 60_000;
  let printedAt: number | null = null;
  for (;;) {
    const counts = await unprocessedDocuments(api);
    const at = now();
    if (counts.waiting === 0 && counts.processing === 0) return { done: true, counts };
    if (printedAt === null || at - printedAt >= PRINT_EVERY_MS) {
      printedAt = at;
      options.onCounts(counts, Math.floor((at - started) / 60_000));
    }
    if (at >= deadline) return { done: false, counts };
    await options.sleep(Math.min(CHECK_EVERY_MS, Math.max(0, deadline - at)));
  }
}
