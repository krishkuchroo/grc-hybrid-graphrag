// An asset-list import's data and words (S3-012, D44), around the generated typed client (D30):
// the import (GET /api/v1/imports/:id), asked again every 2 s while it moves on by itself, and its
// run (POST /api/v1/imports/:id/run), which sends the mapping and whether to save it for the source.
// Every address is relative (the M0-015 rule). Who may run an import is `canImportAssets` (D213 (5),
// R14); the web only hides the button, and the API decides (D7).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSET_IMPORT_FIELDS,
  ASSET_TYPES,
  CRITICALITIES,
  IMPORT_ROLES,
  LABELS,
  REQUIRED_IMPORT_FIELDS,
  type AssetImportField,
  type ImportStatus,
} from '@grc/shared';
import { api, ApiError, type GetImportsIdResponse, type PostImportsIdRunResponse } from '@/api/client';
import { formatRole } from '@/features/auth/session';
import { words } from '@/features/records/format';
import { orList } from '../permissions';
import { intakeKeys } from '../useDocuments';

/** An import as the API answers it. */
export type ImportDetail = GetImportsIdResponse;

/** A sample row: the file's column -> its cell. */
export type SampleRow = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Our field -> the file's column, `''` for a field left unmapped. */
export type MappingDraft = Record<AssetImportField, string>;

/** Under `intakeKeys.all`, so anything that refreshes Data intake refreshes the import too. */
export const importKeys = {
  detail: (id: string) => [...intakeKeys.all, 'import', id] as const,
};

/** How often the page asks again while the import moves on by itself. */
export const IMPORT_REFRESH_MS = 2_000;

/** The statuses that move on by themselves; `needs_mapping` waits for a person. */
export const IMPORT_MOVING: ReadonlySet<ImportStatus> = new Set(['reading', 'queued', 'importing']);

/** Our fields in plain words (D44). */
export const FIELD_TEXT: Readonly<Record<AssetImportField, string>> = {
  sourceId: 'Source ID',
  name: 'Name',
  assetType: 'Asset type',
  criticality: 'Criticality',
  dataClassification: 'Data classification',
  owner: 'Owner (email)',
  hostedOn: 'Hosted on',
  runsOn: 'Runs on',
};

/** The values a list field takes, in words: `Low, Medium, High or Critical`. */
const ALLOWED_TEXT: Readonly<Partial<Record<AssetImportField, string>>> = {
  assetType: orList(ASSET_TYPES.map(words)),
  criticality: orList(CRITICALITIES.map(words)),
  dataClassification: orList(LABELS.map(words)),
};

/** What each field takes from the file. */
export function fieldHint(field: AssetImportField, source: string): string {
  switch (field) {
    case 'sourceId':
      return `The asset’s ID in ${source}. Importing a file from ${source} again matches assets on it.`;
    case 'name':
      return 'What the asset is called.';
    case 'assetType':
    case 'criticality':
      return `${ALLOWED_TEXT[field]}.`;
    case 'dataClassification':
      return `${ALLOWED_TEXT[field]}. It becomes the asset’s label.`;
    case 'owner':
      return 'An org member’s email. Without a match, a new asset is owned by whoever runs the import.';
    case 'hostedOn':
      return 'Source IDs of the assets that host this one. Separate several with a semicolon or comma.';
    case 'runsOn':
      return 'Source IDs of the assets this one runs on. Separate several with a semicolon or comma.';
  }
}

export function isRequired(field: AssetImportField): boolean {
  return (REQUIRED_IMPORT_FIELDS as readonly string[]).includes(field);
}

/** A problem's field in words, or `null` for the whole row. */
export function fieldText(field: unknown): string | null {
  if (typeof field !== 'string' || field === '') return null;
  return (FIELD_TEXT as Readonly<Record<string, string>>)[field] ?? words(field);
}

/** The import's file name, or a stand-in when none is on record. */
export function importFileName(imp: Pick<ImportDetail, 'fileName'>): string {
  return typeof imp.fileName === 'string' && imp.fileName.trim() !== '' ? imp.fileName : 'Asset list';
}

/** The sample rows, as the reader kept them. */
export function sampleRows(imp: Pick<ImportDetail, 'sample'>): SampleRow[] {
  return (imp.sample ?? []) as unknown as SampleRow[];
}

/** A cell as text; `''` for an empty one. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** The API's mapping as the screen holds it: only columns the file has, each used once. */
export function draftFrom(imp: Pick<ImportDetail, 'mapping' | 'columns'>): MappingDraft {
  const columns = imp.columns ?? [];
  const draft = {} as MappingDraft;
  const used = new Set<string>();
  for (const field of ASSET_IMPORT_FIELDS) {
    const column = imp.mapping[field];
    if (typeof column === 'string' && columns.includes(column) && !used.has(column)) {
      draft[field] = column;
      used.add(column);
    } else {
      draft[field] = '';
    }
  }
  return draft;
}

/** Each field's problem with a draft, in plain words: a required field left empty, or a column
 * chosen twice. Empty when it may be sent. */
export function draftProblems(draft: MappingDraft): Partial<Record<AssetImportField, string>> {
  const problems: Partial<Record<AssetImportField, string>> = {};
  const firstUse = new Map<string, AssetImportField>();
  for (const field of ASSET_IMPORT_FIELDS) {
    const column = draft[field];
    if (column === '') {
      if (isRequired(field)) problems[field] = `Choose the column that holds the ${FIELD_TEXT[field]}.`;
      continue;
    }
    const earlier = firstUse.get(column);
    if (earlier) {
      problems[field] = `This column already fills ${FIELD_TEXT[earlier]}. A column can fill one field only.`;
    } else {
      firstUse.set(column, field);
    }
  }
  return problems;
}

/** The run's mapping: our field -> the column, unmapped fields left out. */
export function runMapping(
  draft: MappingDraft,
): { sourceId: string; name: string } & Partial<Record<AssetImportField, string>> {
  const mapping: Partial<Record<AssetImportField, string>> = {};
  for (const field of ASSET_IMPORT_FIELDS) {
    if (draft[field] !== '') mapping[field] = draft[field];
  }
  return { ...mapping, sourceId: draft.sourceId, name: draft.name };
}

/** The roles that may run an import, in words: `Admins, Risk managers, … and Analysts`. */
export function importRolesText(): string {
  const names = IMPORT_ROLES.map((role) => `${formatRole(role)}s`);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const ROW_NOTES: ReadonlySet<string> = new Set(['unknown_owner', 'unknown_parent']);

/** Whether a row problem left the row out, or only notes something about a row that was imported. */
export function problemSkipsRow(problem: { field: unknown; code: string }): boolean {
  if (ROW_NOTES.has(problem.code)) return false;
  // A row naming itself as its own host or platform is still imported, without that link.
  if (problem.code === 'bad_value' && (problem.field === 'hostedOn' || problem.field === 'runsOn')) return false;
  return true;
}

/** A row problem's reason in plain words (never a cell value, D163). */
export function rowProblemText(problem: { field: unknown; code: string }, source: string): string {
  const field = fieldText(problem.field);
  switch (problem.code) {
    case 'missing_value':
      return field ? `${field} is empty, and the row needs it.` : 'A value the row needs is empty.';
    case 'bad_value': {
      if (problem.field === 'hostedOn' || problem.field === 'runsOn') {
        return `The asset names itself in ${field}, so that link wasn’t drawn.`;
      }
      if (problem.field === 'sourceId') return 'The source ID is longer than 200 characters.';
      const allowed = typeof problem.field === 'string' ? ALLOWED_TEXT[problem.field as AssetImportField] : undefined;
      if (allowed) return `${field} isn’t one of ${allowed}.`;
      return field ? `${field} isn’t a valid value.` : 'The row has a value that isn’t valid.';
    }
    case 'label_above_clearance':
      return 'Its data classification is above the clearance of whoever ran the import, so the asset wasn’t imported or changed.';
    case 'duplicate_source_id':
      return 'An earlier row in the file has the same source ID.';
    case 'unknown_owner':
      return 'No member of your organization has this email. A new asset is owned by whoever ran the import; a known asset keeps its owner.';
    case 'unknown_parent':
      return `No asset with that source ID was found in this file or in earlier imports from ${source}, so that link wasn’t drawn.`;
    default:
      return `${words(problem.code)}.`;
  }
}

/** Why a `failed` import failed, in plain words, from its one error. */
export function failureText(imp: Pick<ImportDetail, 'errors' | 'format'>): string {
  const error = imp.errors?.[0];
  const code = error?.code ?? '';
  const near = error && error.row > 0 ? ` (the problem is near row ${error.row.toLocaleString('en-US')})` : '';
  switch (code) {
    case 'too_many_rows':
      return 'The file has more than 50,000 rows. Split it into smaller files and upload each one.';
    case 'too_many_columns':
      return 'The file has more than 200 columns. Remove the columns you don’t need and upload it again.';
    case 'malformed':
      return imp.format === 'json'
        ? `This isn’t a flat JSON list of objects${near}. The file must be one list whose items are objects holding text, numbers, true or false, or null.`
        : `This isn’t a valid CSV file${near}. Check that it has a header row and that its quotes are closed, then upload it again.`;
    case 'timed_out':
      return 'Reading the file took longer than 30 seconds, so it was stopped. Split it into smaller files and upload each one.';
    case 'too_much_memory':
      return 'The file needed more memory than is allowed to read it. Split it into smaller files and upload each one.';
    case 'file_unreadable':
      return 'The stored file couldn’t be read. Upload it again.';
    case 'mapping_missing':
      return 'The import had no mapping to run with. Choose the columns and run it again.';
    case 'mapping_mismatch':
      return 'The mapping names columns this file doesn’t have. Choose the columns again and run it.';
    case 'not_allowed':
      return 'The person who ran it can no longer import asset lists or see this file. Someone who can should run it again.';
    case 'import_failed':
      return 'Something went wrong while writing the assets. It’s tried again automatically; if it stays failed, run it again.';
    case '':
      return 'The import stopped without a reason on record.';
    default:
      return `The import stopped: ${words(code).toLowerCase()}.`;
  }
}

/** The one text for an import that is missing or hidden, whatever the cause (no leak of which). */
export const IMPORT_NOT_FOUND_TEXT = "This import doesn't exist or you can't see it";

/** A refused run, as an ApiError carrying a message in plain words and the API's reference ID. */
export function runProblem(err: unknown, source: string): { title: string; error: unknown } {
  if (!(err instanceof ApiError)) return { title: 'The import didn’t start', error: err };
  const plain = (message: string) => new ApiError(err.status, err.code, message, err.referenceId);
  if (err.status === 409 && err.code === 'import_busy') {
    return {
      title: 'This import is already running',
      error: plain('It was started somewhere else a moment ago. Its progress shows here; wait for it to finish.'),
    };
  }
  if (err.status === 409 && err.code === 'stale_version') {
    return {
      title: 'The saved mapping changed',
      error: plain(
        `Someone saved a different mapping for ${source} since you opened this page. Reload to see it, then run the import again.`,
      ),
    };
  }
  if (err.status === 409 && err.code === 'import_not_ready') {
    return { title: 'This file can’t be imported yet', error: err };
  }
  if (err.status === 400) {
    const fields = [...err.message.matchAll(/mapping\.([A-Za-z]+): the file has no such column/g)].map(
      (m) => fieldText(m[1]) ?? '',
    );
    return {
      title: 'The import didn’t start',
      error: plain(
        fields.length > 0
          ? `The file has no such column for ${orList(fields)}. Choose the columns again.`
          : 'The mapping wasn’t accepted. Check the chosen columns and try again.',
      ),
    };
  }
  if (err.status === 403) {
    return { title: 'You can’t run this import', error: plain(`Only ${importRolesText()} can import asset lists.`) };
  }
  if (err.status === 404) {
    return { title: 'The import didn’t start', error: plain(`${IMPORT_NOT_FOUND_TEXT}.`) };
  }
  if (err.status === 429) {
    return { title: 'The import didn’t start', error: plain('Too many requests. Wait a minute and try again.') };
  }
  return { title: 'The import didn’t start', error: err };
}

/** One import, asked again every 2 s while it's reading, queued or importing. */
export function useImportDetail(id: string) {
  return useQuery({
    queryKey: importKeys.detail(id),
    queryFn: () => api.getImportsId({ id }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (query.state.status === 'error' || status === undefined) return false;
      return IMPORT_MOVING.has(status) ? IMPORT_REFRESH_MS : false;
    },
    retry: false,
  });
}

export interface RunInput {
  draft: MappingDraft;
  saveForSource: boolean;
}

/** Runs the import with a mapping; afterwards the import and Data intake ask the API again. */
export function useRunImport(id: string) {
  const queryClient = useQueryClient();
  return useMutation<PostImportsIdRunResponse, unknown, RunInput>({
    mutationFn: ({ draft, saveForSource }) =>
      api.postImportsIdRun({ id }, { mapping: runMapping(draft), saveForSource }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: intakeKeys.all }),
  });
}
