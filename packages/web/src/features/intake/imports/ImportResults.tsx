// What a finished import did (S3-012, D44), after ServiceNow's transform history (D2): the assets
// added, updated, left unchanged and failed, the links added, and every row problem the worker kept
// (at most 200) with its row number, the asset field and the reason in plain words. A row problem
// either skipped the row or only notes something about a row that was imported.
import { Link } from '@tanstack/react-router';
import { Boxes } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fieldText, problemSkipsRow, rowProblemText, type ImportDetail } from './useImport';

/** The most row problems the worker keeps for one import. */
export const KEPT_PROBLEMS = 200;

type Counts = NonNullable<ImportDetail['counts']>;

function Stat({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: number;
  tone?: 'bad' | undefined;
  className?: string;
}) {
  return (
    <div className={cn('bg-card grid content-start gap-1 px-5 py-4', className)}>
      <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
      <dd
        className={cn(
          'text-3xl leading-none font-bold tabular-nums',
          tone === 'bad' && value > 0 ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value.toLocaleString('en-US')}
      </dd>
    </div>
  );
}

export function ImportCounts({ counts }: { counts: Counts }) {
  return (
    <dl aria-label="Import results" className="bg-border grid grid-cols-2 gap-px sm:grid-cols-5">
      <Stat label="Added" value={counts.added} />
      <Stat label="Updated" value={counts.updated} />
      <Stat label="Unchanged" value={counts.unchanged} />
      <Stat label="Failed" value={counts.failed} tone="bad" />
      <Stat label="Links added" value={counts.linksAdded} className="col-span-2 sm:col-span-1" />
    </dl>
  );
}

export function RowProblems({ errors, source }: { errors: NonNullable<ImportDetail['errors']>; source: string }) {
  const sorted = [...errors].sort((a, b) => a.row - b.row);
  const skipped = sorted.filter(problemSkipsRow).length;
  const notes = sorted.length - skipped;
  return (
    <section aria-labelledby="row-problems-title" className="border-t">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
        <h3 id="row-problems-title" className="text-sm font-semibold">
          Row problems
        </h3>
        <p className="text-muted-foreground text-xs">
          {skipped.toLocaleString('en-US')} skipped {skipped === 1 ? 'a row' : 'rows'}, {notes.toLocaleString('en-US')}{' '}
          {notes === 1 ? 'note' : 'notes'} on imported rows.
          {errors.length >= KEPT_PROBLEMS ? ` Only the first ${KEPT_PROBLEMS} problems are kept.` : ''}
        </p>
      </div>
      <div className="max-h-[28rem] overflow-auto border-t">
        <table className="w-full text-sm">
          <thead className="bg-muted sticky top-0 z-[1] text-xs shadow-[0_1px_0_var(--color-border)]">
            <tr>
              <th scope="col" className="h-9 w-16 px-4 text-right font-semibold">
                Row
              </th>
              <th scope="col" className="h-9 w-44 px-3 text-left font-semibold">
                Field
              </th>
              <th scope="col" className="h-9 px-3 text-left font-semibold">
                Problem
              </th>
              <th scope="col" className="h-9 w-40 px-4 text-left font-semibold">
                Outcome
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((problem, i) => {
              const skips = problemSkipsRow(problem);
              return (
                <tr
                  key={`${problem.row}-${String(problem.field)}-${problem.code}-${i}`}
                  className="even:bg-muted/30 border-b last:border-0"
                >
                  <td className="px-4 py-2 text-right align-top tabular-nums">
                    {problem.row > 0 ? problem.row.toLocaleString('en-US') : '—'}
                  </td>
                  <td className="px-3 py-2 align-top whitespace-nowrap">
                    {fieldText(problem.field) ?? <span className="text-muted-foreground">Whole row</span>}
                  </td>
                  <td className="px-3 py-2 align-top">{rowProblemText(problem, source)}</td>
                  <td className="px-4 py-2 align-top whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                      <span
                        className={cn('size-2 rounded-full', skips ? 'bg-[#b42318]' : 'bg-[#d4a017]')}
                        aria-hidden
                      />
                      {skips ? 'Row skipped' : 'Imported, with a note'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ImportResults({ imp, footer }: { imp: ImportDetail; footer?: ReactNode }) {
  const counts: Counts = imp.counts ?? { added: 0, updated: 0, unchanged: 0, failed: 0, linksAdded: 0 };
  const errors = imp.errors ?? [];
  return (
    <section aria-labelledby="results-title" className="bg-card rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5">
        <h2 id="results-title" className="text-sm font-semibold">
          Results
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {footer}
          <Button asChild size="sm">
            <Link to="/assets">
              <Boxes aria-hidden />
              Open the Assets list
            </Link>
          </Button>
        </div>
      </div>
      <ImportCounts counts={counts} />
      {errors.length > 0 ? (
        <RowProblems errors={errors} source={imp.source} />
      ) : (
        <p className="text-muted-foreground border-t px-5 py-4 text-sm">Every row was imported without a problem.</p>
      )}
    </section>
  );
}
