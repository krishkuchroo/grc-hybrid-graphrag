// Home: who you are signed in as, and a way into each workspace screen. The dashboard's charts
// arrive with slice 8.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { api } from '@/api/client';
import { PageHeader } from '@/app/ScreenPage';
import { SCREEN_GROUPS } from '@/app/screens';
import { formatRole, ME_KEY } from '@/features/auth/session';

export function HomePage() {
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: Infinity });
  if (!me) return null;
  const firstName = me.user.name.split(/\s+/)[0] ?? me.user.name;

  return (
    <>
      <PageHeader title={`Welcome, ${firstName}`} summary="Pick up where your organisation's risk work stands." />
      <div className="grid gap-6 px-8 py-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="workspaces" className="bg-card rounded-lg border">
          <h2 id="workspaces" className="border-b px-5 py-3 text-sm font-semibold">
            Workspaces
          </h2>
          {SCREEN_GROUPS.map((group) => (
            <div key={group.label}>
              <h3 className="text-muted-foreground bg-muted/60 border-b px-5 py-1.5 text-xs font-semibold">
                {group.label}
              </h3>
              <ul className="divide-y border-b last:border-b-0">
                {group.screens.map((screen) => {
                  const Icon = screen.icon;
                  return (
                    <li key={screen.path}>
                      <Link
                        to={screen.path}
                        className="hover:bg-accent/60 focus-visible:bg-accent flex items-center gap-4 px-5 py-3 focus-visible:outline-none"
                      >
                        <Icon className="text-primary size-4 shrink-0" aria-hidden />
                        <span className="grid min-w-0 gap-0.5">
                          <span className="text-sm font-semibold">{screen.label}</span>
                          <span className="text-muted-foreground truncate text-xs">{screen.summary}</span>
                        </span>
                        <ChevronRight className="text-muted-foreground ml-auto size-4 shrink-0" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        <aside aria-labelledby="access" className="bg-card h-fit rounded-lg border">
          <h2 id="access" className="border-b px-5 py-3 text-sm font-semibold">
            Your access
          </h2>
          <dl className="grid gap-4 px-5 py-4 text-sm">
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs">Role</dt>
              <dd className="font-semibold">{formatRole(me.role)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs">Clearance</dt>
              <dd className="font-semibold">{formatRole(me.clearance)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs">Signed in as</dt>
              <dd className="truncate">{me.user.email}</dd>
            </div>
          </dl>
          <p className="text-muted-foreground border-t px-5 py-3 text-xs leading-relaxed">
            Records above your clearance, and record types your role can&apos;t see, stay hidden everywhere, including
            in answers from the assistant.
          </p>
        </aside>
      </div>
    </>
  );
}
