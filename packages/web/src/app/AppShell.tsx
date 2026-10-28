// The signed-in frame of Warrant (D262), after ServiceNow's workspace (D2): a dark header with the
// Warrant mark and name, the org, the person, their role and sign-out, and a dark left navigation to
// the screens (D27). For the roles that see the Analyst review queue (Admin and Analyst), its menu
// item shows how many findings wait (GET /api/v1/review/counts), asked again every minute and after
// each decision (S5-005). A screen only some roles can use (Benchmark: Admins, S8-010) is left out
// of everyone else's menu.
// - Ask (screen 9, S6-007, D262) is a page and a quick panel. "Ask" sits in the menu under Home for
//   every role (the Chat cell is every role's, D50): it opens the Ask page with the open
//   conversation, or a new one, is marked on /ask and /ask/<id>, and shows a pulsing dot while an
//   answer is being written. "Ask" in the header opens the quick panel over any other screen.
// - The whole frame sits in ChatSessionProvider, the one chat session the panel, the page and the
//   menu share. It lives inside the shell's route, so signing out unmounts it and the next person
//   starts with nothing.
import { canViewReviewQueue } from '@grc/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { Building2, LogOut, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { HOME, isScreenShown, SCREEN_GROUPS, type Screen } from '@/app/screens';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { formatRole, initials, ME_KEY } from '@/features/auth/session';
import { isAskPath } from '@/features/chat/AskPage';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { ChatSessionProvider, useSharedChatSession } from '@/features/chat/ChatSessionProvider';
import { useReviewCounts } from '@/features/review/useReview';

/** How many wait, as the menu shows it: nothing for none, `99+` past 99. */
function WaitingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="bg-brand text-chrome ml-auto min-w-5 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-bold tabular-nums">
      {count > 99 ? '99+' : count}
      <span className="sr-only"> waiting</span>
    </span>
  );
}

/** A menu item, marked (data-status, aria-current) on its own screen. */
const NAV_LINK_CLASS =
  'text-chrome-muted hover:bg-chrome-raised relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none data-[status=active]:bg-chrome-raised data-[status=active]:font-semibold data-[status=active]:text-white data-[status=active]:before:absolute data-[status=active]:before:inset-y-1.5 data-[status=active]:before:left-0 data-[status=active]:before:w-[3px] data-[status=active]:before:rounded-full data-[status=active]:before:bg-brand';

function NavLink({ screen, waiting }: { screen: Screen; waiting?: number | undefined }) {
  const Icon = screen.icon;
  return (
    <Link to={screen.path} activeOptions={{ exact: true }} className={NAV_LINK_CLASS}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{screen.label}</span>
      {waiting !== undefined ? <WaitingBadge count={waiting} /> : null}
    </Link>
  );
}

/** "Ask" in the menu: back to the open conversation on the Ask page (or a new one), marked on
 * /ask and /ask/<id> alike, with the header button's pulsing dot while an answer is being written. */
function AskNavLink() {
  const session = useSharedChatSession();
  const onAskPage = useLocation({ select: (location) => isAskPath(location.pathname) });
  const id = session.conversationId;
  // The link's own match marks only the address it points to, so the page's two addresses are
  // marked here.
  const marked = onAskPage ? ({ 'data-status': 'active', 'aria-current': 'page' } as const) : {};
  const content = (
    <>
      <Sparkles className="size-4 shrink-0" aria-hidden />
      <span className="truncate">Ask</span>
      {session.busy ? (
        <>
          <span aria-hidden className="bg-brand ml-auto size-1.5 shrink-0 animate-pulse rounded-full" />
          <span className="sr-only">(an answer is being written)</span>
        </>
      ) : null}
    </>
  );
  return id === null ? (
    <Link to="/ask" className={NAV_LINK_CLASS} {...marked}>
      {content}
    </Link>
  ) : (
    <Link to="/ask/$id" params={{ id }} className={NAV_LINK_CLASS} {...marked}>
      {content}
    </Link>
  );
}

export function AppShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The shell's route has just asked the API, so this reads the answer from the cache.
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: Infinity });
  const reviewCounts = useReviewCounts(me !== undefined && canViewReviewQueue(me.role));

  const signOut = useMutation({
    mutationFn: () => api.postAuthSignOut({}),
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/sign-in' });
    },
  });

  if (!me) return null;

  return (
    <ChatSessionProvider>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <header className="bg-chrome text-chrome-foreground flex h-14 items-center gap-4 border-b border-black/30 px-4">
          <BrandMark />
          <div className="ml-auto flex min-w-0 items-center gap-4">
            <ChatPanel />
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
              <li>
                <AskNavLink />
              </li>
            </ul>
            {SCREEN_GROUPS.map((group) => {
              const screens = group.screens.filter((screen) => isScreenShown(screen, me.role));
              if (screens.length === 0) return null;
              return (
                <div key={group.label} className="grid gap-1">
                  <h2 className="text-chrome-muted/80 px-3 text-xs font-semibold">{group.label}</h2>
                  <ul className="grid gap-0.5">
                    {screens.map((screen) => (
                      <li key={screen.path}>
                        <NavLink
                          screen={screen}
                          waiting={screen.path === '/review' ? reviewCounts.data?.total : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          <main className="min-h-0 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </ChatSessionProvider>
  );
}
