// A workspace screen whose records arrive with a later slice: its title, what it is for, and an
// empty state.
import type { Screen } from '@/app/screens';

export function PageHeader({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="bg-card border-b px-8 py-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">{summary}</p>
    </div>
  );
}

export function ScreenPage({ screen }: { screen: Screen }) {
  const Icon = screen.icon;
  return (
    <>
      <PageHeader title={screen.label} summary={screen.summary} />
      <div className="px-8 py-8">
        <div className="bg-card flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
          <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
            <Icon className="size-5" aria-hidden />
          </span>
          <p className="max-w-md text-sm">{screen.empty}</p>
        </div>
      </div>
    </>
  );
}
