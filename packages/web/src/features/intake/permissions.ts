// What the Data intake screen (D27 #10) offers each person, from the D50 role table and the D51
// labels in @grc/shared, and the checks a file gets before it is sent (D53). The web only hides
// choices and stops files it knows the API would refuse; the API decides (D7).
import {
  can,
  canUpload,
  DOCUMENT_RECORD_TYPE,
  FILE_FORMATS,
  isVisible,
  KIND_FORMATS,
  LABELS,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  UPLOAD_KINDS,
  type DocumentKind,
  type FileFormat,
  type Label,
  type UploadKind,
} from '@grc/shared';

/** What each kind is called on screen. */
export const KIND_TEXT: Readonly<Record<DocumentKind, string>> = {
  asset_list: 'Asset list',
  policy_document: 'Policy document',
  soc_ticket: 'SOC tickets',
  audit_report: 'Audit report',
  evidence: 'Evidence',
};

/** Each kind as the start of a sentence: `An asset list takes CSV or JSON files`. */
const KIND_SENTENCE: Readonly<Record<UploadKind, string>> = {
  asset_list: 'An asset list',
  policy_document: 'A policy document',
  soc_ticket: 'A SOC ticket file',
  audit_report: 'An audit report',
};

/** A line on what each kind is, for the kind chooser. */
export const KIND_HINT: Readonly<Record<UploadKind, string>> = {
  asset_list: 'A CMDB or inventory export, mapped column by column into Assets.',
  policy_document: 'A policy, read for the controls it governs.',
  soc_ticket: 'SOC tickets, read for incidents and what they touched.',
  audit_report: 'An audit report, read for its findings.',
};

export const FORMAT_TEXT: Readonly<Record<FileFormat, string>> = {
  pdf: 'PDF',
  docx: 'DOCX',
  csv: 'CSV',
  json: 'JSON',
  txt: 'TXT',
};

/** `['PDF', 'DOCX', 'TXT']` → `PDF, DOCX or TXT`. */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** The formats a kind takes, in words: `CSV or JSON`. */
export function kindFormatsText(kind: DocumentKind): string {
  return orList(KIND_FORMATS[kind].map((f) => FORMAT_TEXT[f]));
}

/** The kinds the person may upload (`canUpload`): none for the Control Owner, Auditor and Viewer. */
export function uploadKinds(role: string): UploadKind[] {
  return UPLOAD_KINDS.filter((kind) => canUpload(role, kind));
}

/** The kinds whose documents the person's role can see, for the table's kind filter. */
export function listedKinds(role: string): UploadKind[] {
  return UPLOAD_KINDS.filter((kind) => can(role, DOCUMENT_RECORD_TYPE[kind], 'view'));
}

/** The labels an upload may get: none above the person's clearance (D51, D198). */
export function uploadLabelChoices(clearance: string): Label[] {
  return LABELS.filter((label) => isVisible(clearance, label));
}

/** The API's own default for an upload. */
export const DEFAULT_UPLOAD_LABEL: Label = 'internal';

/** Internal, or the highest label the person may give when Internal is above their clearance. */
export function startingUploadLabel(clearance: string): Label | undefined {
  const choices = uploadLabelChoices(clearance);
  if (choices.includes(DEFAULT_UPLOAD_LABEL)) return DEFAULT_UPLOAD_LABEL;
  return choices[choices.length - 1];
}

/** `1536` → `1.5 KB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
  return `${shown} ${units[unit]}`;
}

/** The file name's extension, lowercase, or '' when it has none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 || dot === fileName.length - 1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function isFileFormat(value: string): value is FileFormat {
  return (FILE_FORMATS as readonly string[]).includes(value);
}

const ACCEPTED_TEXT = orList(FILE_FORMATS.map((f) => FORMAT_TEXT[f]));

/**
 * What's wrong with a file for a kind, in plain words, or null when it may be sent. The API checks
 * the contents again (D53); this stops what it would refuse by name or size alone.
 */
export function checkUploadFile(kind: UploadKind, file: { name: string; size: number }): string | null {
  const name = file.name.split(/[/\\]/).pop() ?? '';
  if (name.trim() === '') return 'The file needs a name.';
  if ([...name].length > MAX_FILE_NAME_LENGTH) {
    return `The file name is longer than ${MAX_FILE_NAME_LENGTH} characters. Rename the file and try again.`;
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `This file is ${formatBytes(file.size)}. Files are limited to 25 MB.`;
  }
  const ext = extensionOf(name);
  if (ext === 'zip') return `Zip files aren’t accepted. Upload a ${ACCEPTED_TEXT} file.`;
  if (!isFileFormat(ext)) {
    return ext === ''
      ? `The file name needs its type at the end, such as .pdf or .csv. Upload a ${ACCEPTED_TEXT} file.`
      : `.${ext} files aren’t accepted. Upload a ${ACCEPTED_TEXT} file.`;
  }
  if (!KIND_FORMATS[kind].includes(ext)) {
    return `${KIND_SENTENCE[kind]} takes ${kindFormatsText(kind)} files, and this is a ${FORMAT_TEXT[ext]} file.`;
  }
  return null;
}

/** The `accept` list for the file picker: the kind's extensions. */
export function acceptFor(kind: UploadKind): string {
  return KIND_FORMATS[kind].map((f) => `.${f}`).join(',');
}
