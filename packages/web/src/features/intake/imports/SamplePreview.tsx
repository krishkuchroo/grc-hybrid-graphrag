// The file's first rows (S3-012, D44): up to 5 sample rows under the file's own column names, as
// the worker read them. A column the mapping uses is highlighted and tagged with the asset field it
// fills, so the person sees what each field will take before running the import.
import { ASSET_IMPORT_FIELDS, type AssetImportField } from '@grc/shared';
import { cn } from '@/lib/utils';
import { cellText, FIELD_TEXT, type MappingDraft, type SampleRow } from './useImport';

export interface SamplePreviewProps {
  columns: readonly string[];
  sample: readonly SampleRow[];
  /** The mapping so far; its columns are highlighted. Without one, nothing is. */
  draft?: MappingDraft | undefined;
  rowCount: number | null;
}

export function SamplePreview({ columns, sample, draft, rowCount }: SamplePreviewProps) {
  /** Column -> the field it fills. */
  const fills = new Map<string, AssetImportField>();
  if (draft) {
    for (const field of ASSET_IMPORT_FIELDS) {
      if (draft[field] !== '' && !fills.has(draft[field])) fills.set(draft[field], field);
    }
  }
  const total = rowCount ?? sample.length;

  return (
    <section aria-labelledby="sample-rows-title" className="bg-card min-w-0 rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-2.5">
        <h2 id="sample-rows-title" className="text-sm font-semibold">
          Sample rows
        </h2>
        <p className="text-muted-foreground text-xs">
          The first {sample.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')}{' '}
          {total === 1 ? 'row' : 'rows'}, under the file’s own column names.
          {draft ? ' Highlighted columns are the ones being imported.' : ''}
        </p>
      </div>
      {sample.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-center text-sm">The file has no rows under its header.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby="sample-rows-title">
            <thead>
              <tr className="border-b">
                <th
                  scope="col"
                  className="bg-muted/70 text-muted-foreground h-9 w-12 px-3 text-right text-xs font-semibold"
                >
                  Row
                </th>
                {columns.map((column) => {
                  const field = fills.get(column);
                  return (
                    <th
                      key={column}
                      scope="col"
                      data-mapped={field ? 'true' : undefined}
                      className={cn(
                        'h-auto px-3 py-2 text-left align-bottom text-xs font-semibold whitespace-nowrap',
                        field
                          ? 'bg-accent text-accent-foreground shadow-[inset_0_3px_0_var(--color-primary)]'
                          : 'bg-muted/70',
                      )}
                    >
                      <span className="block">{column}</span>
                      {field ? (
                        <span className="bg-primary text-primary-foreground mt-1 inline-block rounded-sm px-1.5 py-0.5 text-[0.6875rem] leading-none font-semibold">
                          {FIELD_TEXT[field]}
                        </span>
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sample.map((row, i) => (
                <tr key={i} className="even:bg-muted/30 border-b last:border-0">
                  <td className="text-muted-foreground px-3 py-2 text-right text-xs tabular-nums">{i + 1}</td>
                  {columns.map((column) => {
                    const text = cellText(row[column]);
                    return (
                      <td
                        key={column}
                        className={cn(
                          'max-w-[16rem] truncate px-3 py-2',
                          fills.has(column) && 'bg-accent/60 font-semibold',
                        )}
                        title={text === '' ? undefined : text}
                      >
                        {text === '' ? <span className="text-muted-foreground font-normal">—</span> : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
