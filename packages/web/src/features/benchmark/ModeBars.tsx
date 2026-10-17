// Hybrid against vector only as a chart (S8-010, D33: the shadcn chart component over Recharts): one
// row per metric or question kind, a bar for each mode on a shared 0 to 1 scale with its value at
// the end, and under each row's name the difference, green when it favours hybrid and red when it
// doesn't. The drawing is hidden from screen readers, which get the same numbers in words.
import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { useReducedMotion } from '@/features/dashboard/tones';
import { cn } from '@/lib/utils';
import { formatScore, MODE_COLOR, scoreDiff, type ScoreDiff } from './words';

export interface ModeBarRow {
  key: string;
  label: string;
  /** The metric whose values these are (for how they read and which way is better). */
  metric: string;
  hybrid: number | null;
  vector: number | null;
}

const CONFIG: ChartConfig = {
  hybrid: { label: 'Hybrid', color: MODE_COLOR.hybrid },
  vector: { label: 'Vector only', color: MODE_COLOR.vector },
};

const DIFF_FILL: Record<ScoreDiff['tone'], string> = {
  better: '#1f5c38',
  worse: '#8f1f15',
  even: '#5b6b74',
  none: '#5b6b74',
};

/** The row's name and, under it, the difference. */
function RowTick({
  x,
  y,
  payload,
  rows,
}: {
  x: number | string;
  y: number | string;
  payload: { value: unknown };
  rows: readonly ModeBarRow[];
}) {
  const row = rows.find((r) => r.key === payload.value);
  if (!row) return <g />;
  const diff = scoreDiff(row.metric, row.hybrid, row.vector);
  const noValues = row.hybrid === null && row.vector === null;
  return (
    <g transform={`translate(${Number(x)},${Number(y)})`}>
      <text x={-10} y={-3} textAnchor="end" className="fill-foreground" fontSize={12} fontWeight={600}>
        {row.label}
      </text>
      <text x={-10} y={12} textAnchor="end" fontSize={11} fontWeight={700} fill={DIFF_FILL[diff.tone]}>
        {noValues
          ? 'Not measured'
          : diff.tone === 'none'
            ? 'One mode only'
            : diff.tone === 'even'
              ? 'Even'
              : `${diff.text} ${diff.tone === 'better' ? 'better' : 'worse'}`}
      </text>
    </g>
  );
}

/** The numbers in words, for screen readers. */
function rowsInWords(rows: readonly ModeBarRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.label}: hybrid ${formatScore(row.metric, row.hybrid)}, vector only ${formatScore(row.metric, row.vector)}. ${scoreDiff(row.metric, row.hybrid, row.vector).sentence}`,
    )
    .join(' ');
}

export function ModeBars({
  rows,
  labelWidth = 196,
  className,
}: {
  rows: readonly ModeBarRow[];
  /** Room for the rows' names, in pixels. */
  labelWidth?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const data = rows.map((row) => ({
    key: row.key,
    hybrid: row.hybrid,
    vector: row.vector,
    hybridText: row.hybrid === null ? '' : formatScore(row.metric, row.hybrid),
    vectorText: row.vector === null ? '' : formatScore(row.metric, row.vector),
  }));
  const height = rows.length * 58 + 8;
  return (
    <div className={cn('grid', className)}>
      <div aria-hidden>
        <ChartContainer config={CONFIG} className="aspect-auto w-full" style={{ height }}>
          <BarChart
            accessibilityLayer={false}
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 44, bottom: 4, left: 0 }}
            barCategoryGap="22%"
            barGap={3}
          >
            <XAxis type="number" hide domain={[0, 1]} />
            <YAxis
              type="category"
              dataKey="key"
              width={labelWidth}
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={(props: { x: number | string; y: number | string; payload: { value: unknown } }) => (
                <RowTick {...props} rows={rows} />
              )}
            />
            <Bar
              dataKey="hybrid"
              fill="var(--color-hybrid)"
              radius={3}
              minPointSize={2}
              maxBarSize={16}
              isAnimationActive={!reduced}
            >
              <LabelList
                dataKey="hybridText"
                position="right"
                offset={6}
                className="fill-foreground"
                fontSize={12}
                fontWeight={700}
              />
            </Bar>
            <Bar
              dataKey="vector"
              fill="var(--color-vector)"
              radius={3}
              minPointSize={2}
              maxBarSize={16}
              isAnimationActive={!reduced}
            >
              <LabelList
                dataKey="vectorText"
                position="right"
                offset={6}
                className="fill-muted-foreground"
                fontSize={12}
                fontWeight={600}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>
      <p className="sr-only">{rowsInWords(rows)}</p>
    </div>
  );
}
