// Evidence in the web app (S3-013, D202, D213 (2)-(4)), around the generated typed client (D30):
// GET /api/v1/controls/:id/evidence (the section on a control page), POST /api/v1/evidence (the add
// dialog, a multipart upload with progress), PATCH and retire on /api/v1/evidence/:id, GET
// /api/v1/evidence/:id (a stale edit's reload), GET /api/v1/evidence/:id/download and POST
// /api/v1/evidence/:id/review (Accept and Reject, S3-022). Every address is relative (the M0-015
// rule). The web only hides what the API would refuse, with S3-002's rules (`canAddEvidence`) and the
// API's own `canEdit` and `canReview` per item; the API decides (D7, D220 (4)).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  can,
  canAddEvidence,
  canChangeLabel,
  defaultLabel,
  evidenceDateProblems,
  isLabel,
  isVisible,
  KIND_FORMATS,
  LABELS,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  type EvidenceReviewStatus,
  type EvidenceValidity,
  type FileFormat,
  type Label,
} from '@grc/shared';
import {
  api,
  ApiError,
  type GetControlsIdEvidenceResponse,
  type PatchEvidenceIdBody,
  type PostEvidenceBody,
  type PostEvidenceIdReviewBody,
  type UploadProgress,
} from '@/api/client';
import type { Viewer } from '@/features/records/permissions';
import { extensionOf, formatBytes, FORMAT_TEXT, orList } from '../permissions';
import { saveFile } from '../useDocuments';

/** An evidence item as the API returns it: the record, its visible controls, `validity`, the
 * reviewer's name, `canEdit` and `canReview`. */
export type Evidence = GetControlsIdEvidenceResponse['items'][number];

/** A review's outcome (D213 (2)): every review status but `pending`. */
export type EvidenceDecision = PostEvidenceIdReviewBody['decision'];

export const evidenceKeys = {
  all: ['evidence'] as const,
  forControl: (controlId: string) => ['evidence', 'control', controlId] as const,
};

/** The review statuses in plain words (D213 (2)). */
export const REVIEW_TEXT: Readonly<Record<EvidenceReviewStatus, string>> = {
  pending: 'Pending review',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

export function reviewText(status: string): string {
  return REVIEW_TEXT[status as EvidenceReviewStatus] ?? status;
}

/** The API's `validity` in plain words: "Expiring soon" is within 30 days (D213 (2)). */
export const VALIDITY_TEXT: Readonly<Record<EvidenceValidity, string>> = {
  valid: 'Valid',
  expiring: 'Expiring soon',
  expired: 'Expired',
};

export function validityText(validity: string): string {
  return VALIDITY_TEXT[validity as EvidenceValidity] ?? validity;
}

// ---- Who sees what ---------------------------------------------------------------------------

/** Whether the person's role ever sees evidence (D50: everyone but the Viewer). A Control Owner sees
 * it only on controls they own, which the API decides (D213 (3)): elsewhere it answers 404. */
export function mayViewEvidence(viewer: Viewer | null): boolean {
  return viewer !== null && can(viewer.role, 'evidence', 'view', { isOwner: true });
}

/** "Add evidence": the Admin on any control they can see; a Control Owner only on a control they
 * own (S3-002's `canAddEvidence`, D213 (3)). */
export function mayAddEvidence(viewer: Viewer | null, control: { label: string; owner: string }): boolean {
  return viewer !== null && canAddEvidence(viewer, control);
}

/** Edit and Retire on an item: the API's `canEdit` (the Admin, or the Control Owner who added it),
 * and only while it's active. */
export function mayChangeEvidence(item: Pick<Evidence, 'canEdit' | 'status'>): boolean {
  return item.canEdit === true && item.status === 'active';
}

/** Accept and Reject on an item: the API's `canReview` (an Admin or a Compliance Manager who sees it
 * and didn't add it, D220 (4)), and only while it's active. The API checks again and decides (D7). */
export function mayReviewEvidence(item: Pick<Evidence, 'canReview' | 'status'>): boolean {
  return item.canReview === true && item.status === 'active';
}

/** The labels new evidence may get: none above the person's clearance (D198). */
export function evidenceLabelChoices(viewer: Viewer): Label[] {
  return LABELS.filter((label) => isVisible(viewer.clearance, label));
}

/** New evidence starts Confidential (D51's default for evidence), or at the clearance if that's lower. */
export function startingEvidenceLabel(viewer: Viewer): Label {
  const wanted = defaultLabel('evidence');
  const choices = evidenceLabelChoices(viewer);
  if (choices.includes(wanted)) return wanted;
  return choices[choices.length - 1] ?? wanted;
}

/** The labels an edit may set: the changes `canChangeLabel` allows, none above the clearance. The
 * stored label is always kept as a choice. */
export function editEvidenceLabelChoices(viewer: Viewer, from: Label): Label[] {
  return LABELS.filter(
    (to) => to === from || (isVisible(viewer.clearance, to) && canChangeLabel(viewer.role, from, to)),
  );
}

// ---- The file, checked before it is sent ----------------------------------------------------

const EVIDENCE_FORMATS: readonly FileFormat[] = KIND_FORMATS.evidence;

/** The formats evidence takes, in words: `PDF, DOCX, CSV, JSON or TXT`. */
export const EVIDENCE_FORMATS_TEXT = orList(EVIDENCE_FORMATS.map((f) => FORMAT_TEXT[f]));

/** The `accept` list for the file picker. */
export const EVIDENCE_ACCEPT = EVIDENCE_FORMATS.map((f) => `.${f}`).join(',');

/**
 * What's wrong with an evidence file, in plain words, or null when it may be sent. The API checks
 * its contents again (D53); this stops what it would refuse by name or size alone.
 */
export function checkEvidenceFile(file: { name: string; size: number }): string | null {
  const name = file.name.split(/[/\\]/).pop() ?? '';
  if (name.trim() === '') return 'The file needs a name.';
  if ([...name].length > MAX_FILE_NAME_LENGTH) {
    return `The file name is longer than ${MAX_FILE_NAME_LENGTH} characters. Rename the file and try again.`;
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return `This file is ${formatBytes(file.size)}. Files are limited to 25 MB.`;
  const ext = extensionOf(name);
  if (ext === 'zip') return `Zip files aren’t accepted. Attach a ${EVIDENCE_FORMATS_TEXT} file.`;
  if (!(EVIDENCE_FORMATS as readonly string[]).includes(ext)) {
    return ext === ''
      ? `The file name needs its type at the end, such as .pdf. Attach a ${EVIDENCE_FORMATS_TEXT} file.`
      : `.${ext} files aren’t accepted. Attach a ${EVIDENCE_FORMATS_TEXT} file.`;
  }
  return null;
}

/** A file name without its type, as a starting name for the evidence: `soc2-report.pdf` → `soc2-report`. */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

// ---- Dates -----------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the person's own calendar, as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayIndex(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** Days from `today` to `date` (negative when it's past), or `null` for a malformed date. */
export function daysUntil(date: string, today: string): number | null {
  const a = dayIndex(today);
  const b = dayIndex(date);
  return a === null || b === null ? null : b - a;
}

/** How far off a valid-until date is, in words: "Ends in 12 days", "Ends today", "Ended 3 days ago". */
export function validUntilHint(validUntil: string | null, today: string): string {
  if (validUntil === null) return 'No end date';
  const days = daysUntil(validUntil, today);
  if (days === null) return '';
  if (days === 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  if (days > 1) return `Ends in ${days} days`;
  if (days === -1) return 'Ended yesterday';
  return `Ended ${-days} days ago`;
}

/** Whether `date` is a real `YYYY-MM-DD` day (not 2026-02-30). */
export function isRealDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** The evidence fields as a form holds them: text, before conversion. */
export interface EvidenceFieldValues {
  name: string;
  collectedDate: string;
  /** Empty when there's no end date. */
  validUntil: string;
  label: string;
}

export type EvidenceFieldErrors = Partial<Record<keyof EvidenceFieldValues, string>>;

/**
 * What to fix in the evidence fields, by field, in the field's own words: a name, a real collected
 * date not after today, and a valid-until date (when there is one) on or after it (S3-002's
 * `evidenceDateProblems`). The API checks again (with its own today) and decides.
 */
export function evidenceFieldProblems(values: EvidenceFieldValues, today: string): EvidenceFieldErrors {
  const errors: EvidenceFieldErrors = {};
  if (values.name.trim() === '') errors.name = 'Enter a name for the evidence.';
  const collected = values.collectedDate.trim();
  const until = values.validUntil.trim();
  if (collected === '') errors.collectedDate = 'Enter the date the evidence was collected.';
  else if (!isRealDate(collected)) errors.collectedDate = 'Enter a real date for Collected.';
  if (until !== '' && !isRealDate(until)) errors.validUntil = 'Enter a real date for Valid until, or leave it empty.';
  if (errors.collectedDate === undefined && errors.validUntil === undefined) {
    for (const p of evidenceDateProblems(
      { collectedDate: collected, validUntil: until === '' ? null : until },
      today,
    )) {
      if (p.code === 'in_future') errors.collectedDate ??= 'Collected can’t be after today.';
      if (p.code === 'before_collected') errors.validUntil ??= 'Valid until must be on or after the collected date.';
    }
  }
  if (!isLabel(values.label)) errors.label = 'Choose a label.';
  return errors;
}

// ---- Queries -------------------------------------------------------------------------------

/** The active evidence supporting a control that the person can see. Nothing is asked for a role
 * that never sees evidence. */
export function useControlEvidence(controlId: string, enabled: boolean) {
  return useQuery({
    queryKey: evidenceKeys.forControl(controlId),
    queryFn: async (): Promise<Evidence[]> => (await api.getControlsIdEvidence({ id: controlId })).items,
    enabled,
  });
}

// ---- Changes -------------------------------------------------------------------------------

/** Puts a saved item into the control's list in place (or takes it out once retired), then asks the
 * API again for every evidence list. */
function useSettle(controlId: string) {
  const queryClient = useQueryClient();
  return async (item: Evidence) => {
    queryClient.setQueryData<Evidence[]>(evidenceKeys.forControl(controlId), (old) => {
      const list = old ?? [];
      if (item.status !== 'active') return list.filter((e) => e.id !== item.id);
      const at = list.findIndex((e) => e.id === item.id);
      if (at === -1) return [...list, item];
      return list.map((e, i) => (i === at ? item : e));
    });
    await queryClient.invalidateQueries({ queryKey: evidenceKeys.all });
  };
}

export interface AddEvidenceInput {
  body: PostEvidenceBody;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** Attaches a file to the control as new evidence (review status pending). */
export function useAddEvidence(controlId: string) {
  const settle = useSettle(controlId);
  return useMutation<Evidence, unknown, AddEvidenceInput>({
    mutationFn: async ({ body, onProgress, signal }) =>
      (await api.postEvidence(body, {
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      })) as Evidence,
    onSuccess: settle,
  });
}

export function useUpdateEvidence(controlId: string, id: string) {
  const settle = useSettle(controlId);
  return useMutation<Evidence, unknown, PatchEvidenceIdBody>({
    mutationFn: async (body) => (await api.patchEvidenceId({ id }, body)) as Evidence,
    onSuccess: settle,
  });
}

export function useRetireEvidence(controlId: string, id: string) {
  const settle = useSettle(controlId);
  return useMutation<Evidence, unknown, number>({
    mutationFn: async (version) => (await api.postEvidenceIdRetire({ id }, { version })) as Evidence,
    onSuccess: settle,
  });
}

/** Accepts or rejects an item with the version the row shows (409 `stale_version` when someone
 * changed it since). The answer, with the reviewer and the review time, replaces the row. */
export function useReviewEvidence(controlId: string, id: string) {
  const settle = useSettle(controlId);
  return useMutation<Evidence, unknown, PostEvidenceIdReviewBody>({
    mutationFn: async (body) => (await api.postEvidenceIdReview({ id }, body)) as Evidence,
    onSuccess: settle,
  });
}

/** The latest copy of one item, for a stale edit's reload; it replaces the one in the control's list. */
export function useReloadEvidence(controlId: string) {
  const queryClient = useQueryClient();
  return async (id: string): Promise<Evidence> => {
    const latest = (await api.getEvidenceId({ id })) as Evidence;
    queryClient.setQueryData<Evidence[]>(evidenceKeys.forControl(controlId), (old) =>
      (old ?? []).map((e) => (e.id === latest.id ? latest : e)),
    );
    return latest;
  };
}

/** Asks the API again for a control's evidence (after a refusal that means the list is out of date). */
export function useRefreshEvidence(controlId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: evidenceKeys.forControl(controlId) });
}

/** Downloads the item's file through the API (audited there as document.downloaded) and saves it. */
export function useDownloadEvidence() {
  return useMutation<void, unknown, Pick<Evidence, 'id' | 'fileName'>>({
    mutationFn: async (item) => {
      const file = await api.getEvidenceIdDownload({ id: item.id });
      saveFile(file.blob, file.fileName ?? item.fileName);
    },
  });
}

// ---- Refusals in plain words ---------------------------------------------------------------

export type EvidenceAction = 'add' | 'edit' | 'retire' | 'download' | 'accept' | 'reject';

const FAILED: Record<EvidenceAction, string> = {
  add: 'The evidence wasn’t added',
  edit: 'Your changes weren’t saved',
  retire: 'The evidence wasn’t retired',
  download: 'The file couldn’t be downloaded',
  accept: 'The evidence wasn’t accepted',
  reject: 'The evidence wasn’t rejected',
};

const REVIEW_FORBIDDEN_WHY =
  'Only an Admin or a Compliance Manager may accept or reject evidence, and never evidence they added themselves.';

const FORBIDDEN: Record<EvidenceAction, string> = {
  add: 'You can’t add evidence to this control',
  edit: 'You can’t change this evidence',
  retire: 'You can’t retire this evidence',
  download: 'You can’t download this file',
  accept: 'You can’t accept this evidence',
  reject: 'You can’t reject this evidence',
};

const FORBIDDEN_WHY: Record<EvidenceAction, string> = {
  add: 'Only an Admin, or the Control Owner of this control, may add evidence, with a label up to their clearance.',
  edit: 'Only an Admin, or the Control Owner who added it, may change evidence.',
  retire: 'Only an Admin, or the Control Owner who added it, may retire evidence.',
  download: 'Your role or clearance doesn’t allow this download.',
  accept: REVIEW_FORBIDDEN_WHY,
  reject: REVIEW_FORBIDDEN_WHY,
};

/** What a refusal says: a title and plain lines. `lines: null` means "show the API's own message
 * and its reference ID" (D47). */
export interface EvidenceProblem {
  title: string;
  lines: string[] | null;
  /** A stale save (409 `stale_version`): the latest version should be loaded. */
  stale?: boolean;
  /** The item or the control is gone or hidden (404): the list should be asked for again. */
  gone?: boolean;
}

export function isStaleVersion(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'stale_version';
}

export function isAborted(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'aborted';
}

const STALE_EDIT =
  'Someone else saved it while you were editing, so your changes weren’t saved. Your typed changes are still in the form below. Reload to get the latest version, then re-apply your changes and save again.';
const STALE_RETIRE =
  'Someone else saved it in the meantime, so it wasn’t retired. The list now shows the latest version; check it, then retire it again if you still want to.';
const STALE_REVIEW: Record<'accept' | 'reject', string> = {
  accept:
    'Someone else changed it in the meantime, so your decision wasn’t saved. The list now shows the latest version; check it, then accept it again if you still want to.',
  reject:
    'Someone else changed it in the meantime, so your decision wasn’t saved. The list now shows the latest version; check it, then reject it again if you still want to.',
};

function staleText(action: EvidenceAction): string {
  if (action === 'retire') return STALE_RETIRE;
  if (action === 'accept' || action === 'reject') return STALE_REVIEW[action];
  return STALE_EDIT;
}

/** A refused Accept or Reject (S3-022): 403, 404 and a stale version in plain words; anything else
 * as the API put it, with its reference ID (D47). */
function reviewProblem(err: ApiError, action: 'accept' | 'reject'): EvidenceProblem {
  if (isStaleVersion(err)) {
    return { title: 'This record changed since you opened it', lines: [staleText(action)], stale: true };
  }
  if (err.status === 403) {
    return {
      title: FORBIDDEN[action],
      lines: [err.message, FORBIDDEN_WHY[action]].filter((line, i, all) => line !== '' && all.indexOf(line) === i),
    };
  }
  if (err.status === 404) {
    return { title: FAILED[action], lines: ['This evidence doesn’t exist or you can’t see it.'], gone: true };
  }
  return { title: FAILED[action], lines: null };
}

/** The API's 409 `evidence_exists`, 415, 413, 429, 403 and 404 (and S1's stale save) in plain words;
 * anything else as the API put it, with its reference ID (D47). */
export function evidenceProblem(err: unknown, action: EvidenceAction): EvidenceProblem {
  if (!(err instanceof ApiError)) return { title: FAILED[action], lines: null };
  if (action === 'accept' || action === 'reject') return reviewProblem(err, action);
  if (err.status === 409 && err.code === 'evidence_exists') {
    return {
      title: 'This file is already evidence for this control',
      lines: ['The same file is already attached to this control. Choose a different file, or keep the one listed.'],
    };
  }
  if (isStaleVersion(err)) {
    return {
      title: 'This record changed since you opened it',
      lines: [staleText(action)],
      stale: true,
    };
  }
  switch (err.status) {
    case 415:
      return {
        title: 'This file type isn’t accepted',
        lines: [
          err.code === 'unsupported_file_type' ? err.message : '',
          `Attach a ${EVIDENCE_FORMATS_TEXT} file whose name ends in its type.`,
        ].filter((line) => line !== ''),
      };
    case 413:
      return { title: 'This file is too big', lines: ['Files are limited to 25 MB.'] };
    case 429:
      return {
        title: action === 'add' ? 'Too many uploads' : 'Too many requests',
        lines: [
          action === 'add' ? 'You can upload 20 files a minute, evidence included.' : 'You’ve sent too many requests.',
          err.retryAfterSeconds
            ? `Try again in ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? '' : 's'}.`
            : 'Wait a minute, then try again.',
        ],
      };
    case 403:
      return {
        title: FORBIDDEN[action],
        lines: [err.message, FORBIDDEN_WHY[action]].filter((line, i, all) => line !== '' && all.indexOf(line) === i),
      };
    case 404:
      return {
        title: FAILED[action],
        lines: [
          action === 'add'
            ? 'This control doesn’t exist or you can’t see it.'
            : 'This evidence doesn’t exist or you can’t see it.',
        ],
        gone: true,
      };
    default:
      return { title: FAILED[action], lines: null };
  }
}
