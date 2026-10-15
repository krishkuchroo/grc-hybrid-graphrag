// The field map (S3-012, D44), after ServiceNow's transform-map field list (D2): one row per asset
// field, each with a chooser of the file's columns and the value the first sample rows hold there.
// "Source ID" and "Name" are required. A column already chosen for one field is shown, but can't be
// picked, for another; the screen checks it again before a run (`draftProblems`).
import { ASSET_IMPORT_FIELDS, type AssetImportField } from '@grc/shared';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { cellText, FIELD_TEXT, fieldHint, isRequired, type MappingDraft, type SampleRow } from './useImport';

/** The first non-empty value the sample holds in a column, or `''`. */
function exampleOf(column: string, sample: readonly SampleRow[]): string {
  for (const row of sample) {
    const text = cellText(row[column]).trim();
    if (text !== '') return text;
  }
  return '';
}

export function fieldSelectId(field: AssetImportField): string {
  return `import-field-${field}`;
}

export interface MappingTableProps {
  columns: readonly string[];
  sample: readonly SampleRow[];
  source: string;
  draft: MappingDraft;
  onChange: (field: AssetImportField, column: string) => void;
  /** Each field's problem, shown under its chooser once the person tried to run. */
  problems: Partial<Record<AssetImportField, string>>;
  disabled?: boolean;
}

export function MappingTable({ columns, sample, source, draft, onChange, problems, disabled }: MappingTableProps) {
  /** Column -> the field it fills. */
  const usedBy = new Map<string, AssetImportField>();
  for (const field of ASSET_IMPORT_FIELDS) {
    if (draft[field] !== '' && !usedBy.has(draft[field])) usedBy.set(draft[field], field);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Asset fields and the file’s columns that fill them</caption>
        <thead className="bg-muted/70 text-xs">
          <tr className="border-b">
            <th scope="col" className="h-9 w-[38%] px-4 text-left font-semibold">
              Asset field
            </th>
            <th scope="col" className="h-9 w-[30%] px-3 text-left font-semibold">
              Column in the file
            </th>
            <th scope="col" className="h-9 px-4 text-left font-semibold">
              Example from the sample
            </th>
          </tr>
        </thead>
        <tbody>
          {ASSET_IMPORT_FIELDS.map((field) => {
            const id = fieldSelectId(field);
            const required = isRequired(field);
            const chosen = draft[field];
            const problem = problems[field];
            const example = chosen === '' ? '' : exampleOf(chosen, sample);
            return (
              <tr
                key={field}
                data-field={field}
                className={cn('border-b align-top last:border-0', chosen !== '' && 'bg-accent/35')}
              >
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <label htmlFor={id} className="font-semibold">
                      {FIELD_TEXT[field]}
                    </label>
                    {required ? (
                      <span className="text-destructive text-xs font-semibold" aria-hidden>
                        Required
                      </span>
                    ) : null}
                  </div>
                  <p id={`${id}-hint`} className="text-muted-foreground mt-0.5 max-w-[46ch] text-xs leading-snug">
                    {fieldHint(field, source)}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <NativeSelect
                    id={id}
                    className="w-full min-w-[12rem]"
                    value={chosen}
                    disabled={disabled}
                    aria-required={required || undefined}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? `${id}-hint ${id}-problem` : `${id}-hint`}
                    onChange={(e) => onChange(field, e.target.value)}
                  >
                    <option value="">{required ? 'Choose a column' : 'Not imported'}</option>
                    {columns.map((column) => {
                      const owner = usedBy.get(column);
                      const takenElsewhere = owner !== undefined && owner !== field;
                      return (
                        <option key={column} value={column} disabled={takenElsewhere}>
                          {takenElsewhere ? `${column} (used for ${FIELD_TEXT[owner]})` : column}
                        </option>
                      );
                    })}
                  </NativeSelect>
                  {problem ? (
                    <p id={`${id}-problem`} className="text-destructive mt-1 text-xs font-semibold">
                      {problem}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {chosen === '' ? (
                    <span className="text-muted-foreground" aria-label="No column chosen">
                      —
                    </span>
                  ) : example === '' ? (
                    <span className="text-muted-foreground">Empty in the sample</span>
                  ) : (
                    <span className="line-clamp-2 [overflow-wrap:anywhere]" title={example}>
                      {example}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
