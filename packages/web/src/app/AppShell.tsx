// The signed-in frame, after ServiceNow's workspace (D2): a dark header with the org, the person,
// their role and sign-out, and a dark left navigation to the screens (D27).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Building2, LogOut } from 'lucide-react';
import { api } from '@/api/client';
import { HOME, SCREEN_GROUPS, type Screen } from '@/app/screens';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { formatRole, initials, ME_KEY } from '@/features/auth/session';

function NavLink({ screen }: { screen: Screen }) {
  const Icon = screen.icon;
  return (
    <Link
      to={screen.path}
      activeOptions={{ exact: true }}
      className="text-chrome-muted hover:bg-chrome-raised relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none data-[status=active]:bg-chrome-raised data-[status=active]:font-semibold data-[status=active]:text-white data-[status=active]:before:absolute data-[status=active]:before:inset-y-1.5 data-[status=active]:before:left-0 data-[status=active]:before:w-[3px] data-[status=active]:before:rounded-full data-[status=active]:before:bg-brand"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{screen.label}</span>
    </Link>
  );
}

export function AppShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The shell's route has just asked the API, so this reads the answer from the cache.
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: Infinity });

  const signOut = useMutation({
    mutationFn: () => api.postAuthSignOut({}),
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/sign-in' });
    },
  });

  if (!me) return null;

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="bg-chrome text-chrome-foreground flex h-14 items-center gap-4 border-b border-black/30 px-4">
        <BrandMark />
        <div className="ml-auto flex min-w-0 items-center gap-4">
          <div className="hidden items-center gap-2 rounded-md border border-white/10 px-2.5 py-1 text-sm sm:flex">
            <Building2 className="text-brand size-4" aria-hidden />
            <span className="max-w-[16rem] truncate font-semibold text-white">{me.org.name}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="bg-brand text-chrome grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold"
            >
              {initials(me.user.name)}
            </span>
            <div className="hidden min-w-0 leading-tight md:block">
              <p className="truncate text-sm font-semibold text-white">{me.user.name}</p>
              <p className="text-chrome-muted truncate text-xs">{formatRole(me.role)}</p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-chrome-foreground hover:bg-chrome-raised hover:text-white"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Main" className="bg-chrome flex min-h-0 flex-col gap-5 overflow-y-auto px-3 py-4">
          <ul className="grid gap-0.5">
            <li>
              <NavLink screen={HOME} />
            </li>
          </ul>
          {SCREEN_GROUPS.map((group) => (
            <div key={group.label} className="grid gap-1">
              <h2 className="text-chrome-muted/80 px-3 text-xs font-semibold">{group.label}</h2>
              <ul className="grid gap-0.5">
                {group.screens.map((screen) => (
                  <li key={screen.path}>
                    <NavLink screen={screen} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main className="min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
