// Home (D27 screen 1): the welcome, the dashboard of the org's risk posture as this person may see
// it (S8-009, ./features/dashboard), and "Your access", which says why the counts are what they are.
// The left menu lists every screen, so the old "Workspaces" list made way for the dashboard (S8-Q7).
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { PageHeader } from '@/app/ScreenPage';
import { formatRole, ME_KEY } from '@/features/auth/session';
import { Dashboard, DashboardSide } from '@/features/dashboard/Dashboard';

export function HomePage() {
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: Infinity });
  if (!me) return null;
  const firstName = me.user.name.split(/\s+/)[0] ?? me.user.name;

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        summary="Where your organisation’s risks, controls, incidents and compliance stand, counted from the records you can see."
      />
      <div className="grid items-start gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Dashboard role={me.role} />

        <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-1">
          <aside aria-labelledby="access" className="bg-card h-fit rounded-lg border shadow-xs">
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
          <DashboardSide role={me.role} />
        </div>
      </div>
    </>
  );
}
