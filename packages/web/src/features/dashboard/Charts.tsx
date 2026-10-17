// The dashboard's charts (S8-009, D33: shadcn charts over Recharts): counts per value as bars or as
// a ring. The drawing is hidden from screen readers, which get the same numbers in words instead;
// the ring's legend shows them on screen too. Colours come from ./tones, the app's badge colours.
import { Bar, BarChart, CartesianGrid, Label, LabelList, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { formatCount } from '@/features/frameworks/CoverageBar';
import { cn } from '@/lib/utils';
import { countOf } from './Tile';
import { useReducedMotion } from './tones';

/** One value's count, with its words and colour. */
export interface CountItem {
  key: string;
  label: string;
  count: number;
  color: string;
}

/** What the counted things are called: `risk`, `risks`. */
export interface Noun {
  one: string;
  many: string;
}

function configOf(items: readonly CountItem[], noun: Noun): ChartConfig {
  const config: ChartConfig = { count: { label: noun.many.charAt(0).toUpperCase() + noun.many.slice(1) } };
  for (const item of items) config[item.key] = { label: item.label, color: item.color };
  return config;
}

/** The numbers in words: "Critical: 3 risks. High: 1 risk." */
export function countsInWords(items: readonly CountItem[], noun: Noun): string {
  return items.map((item) => `${item.label}: ${countOf(item.count, noun.one, noun.many)}.`).join(' ');
}

/** Counts as bars: one column per value (`columns`), or one row per value (`rows`), each labelled. */
export function CountBars({
  items,
  noun,
  layout = 'columns',
  className,
}: {
  items: readonly CountItem[];
  noun: Noun;
  layout?: 'columns' | 'rows';
  className?: string;
}) {
  const reduced = useReducedMotion();
  const data = items.map((item) => ({ key: item.key, label: item.label, count: item.count, fill: item.color }));
  const config = configOf(items, noun);
  const tooltip = <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />;

  return (
    <div className={cn('grid', className)}>
      <div aria-hidden>
        <ChartContainer config={config} className={cn('aspect-auto w-full', layout === 'rows' ? 'h-40' : 'h-44')}>
          {layout === 'rows' ? (
            <BarChart
              accessibilityLayer={false}
              data={data}
              layout="vertical"
              margin={{ top: 0, right: 36, bottom: 0, left: 0 }}
              barCategoryGap="22%"
            >
              <XAxis type="number" hide allowDecimals={false} domain={[0, 'dataMax']} />
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={72}
                tick={{ fontSize: 12 }}
              />
              {tooltip}
              <Bar dataKey="count" radius={4} minPointSize={2} maxBarSize={28} isAnimationActive={!reduced}>
                <LabelList
                  dataKey="count"
                  position="right"
                  offset={8}
                  className="fill-foreground"
                  fontSize={12}
                  fontWeight={700}
                />
              </Bar>
            </BarChart>
          ) : (
            <BarChart accessibilityLayer={false} data={data} margin={{ top: 22, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} />
              <YAxis hide allowDecimals={false} domain={[0, 'dataMax']} />
              {tooltip}
              <Bar dataKey="count" radius={[4, 4, 0, 0]} minPointSize={2} maxBarSize={72} isAnimationActive={!reduced}>
                <LabelList
                  dataKey="count"
                  position="top"
                  offset={6}
                  className="fill-foreground"
                  fontSize={12}
                  fontWeight={700}
                />
              </Bar>
            </BarChart>
          )}
        </ChartContainer>
      </div>
      <p className="sr-only">{countsInWords(items, noun)}</p>
    </div>
  );
}

/** Counts as a ring around their total, with a legend of each value's count and share: side by side in
 * a wide tile, the legend under the ring in a narrow one. */
export function CountRing({ items, noun, className }: { items: readonly CountItem[]; noun: Noun; className?: string }) {
  const reduced = useReducedMotion();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const data = items.map((item) => ({ key: item.key, label: item.label, count: item.count, fill: item.color }));
  const config = configOf(items, noun);

  return (
    <div className={cn('@container', className)}>
      <div className="grid items-center gap-4 @xs:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
        <div aria-hidden>
          <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-40">
            <PieChart accessibilityLayer={false}>
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
              <Pie
                data={data}
                dataKey="count"
                nameKey="key"
                innerRadius="64%"
                outerRadius="96%"
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={!reduced}
              >
                <Label
                  content={({ viewBox }) => {
                    if (!viewBox || !('cx' in viewBox)) return <g />;
                    const { cx, cy } = viewBox;
                    return (
                      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={cx} y={cy - 6} className="fill-foreground text-2xl font-bold">
                          {formatCount(total)}
                        </tspan>
                        <tspan x={cx} y={cy + 14} className="fill-muted-foreground text-[11px]">
                          {total === 1 ? noun.one : noun.many}
                        </tspan>
                      </text>
                    );
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        </div>
        <ul className="grid grid-cols-1 gap-2 text-sm">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: item.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="font-semibold tabular-nums">
                {formatCount(item.count)}
                <span className="sr-only"> {item.count === 1 ? noun.one : noun.many}</span>
              </span>
              <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
                {total === 0 ? 0 : Math.round((item.count / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
