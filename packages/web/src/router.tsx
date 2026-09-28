// The app's routes (TanStack Router, browser history).
// - /sign-in, /sign-in/verify (the second factor) and /mfa/setup are the signed-out screens.
// - Every other screen sits inside the shell, which asks the API who is signed in on every move
//   between screens. A 401 there sends the person to sign-in; if they were signed in a moment ago,
//   the session ended while they were away, and sign-in says so.
// Security is checked by the API (D7); these redirects only decide which screen to show.
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/app/AppShell';
import { HomePage } from '@/app/HomePage';
import { ScreenPage } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { MfaCheckPage } from '@/features/auth/MfaCheckPage';
import { MfaSetupPage } from '@/features/auth/MfaSetupPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { fetchMe, isUnauthorized, ME_KEY } from '@/features/auth/session';

export interface RouterContext {
  queryClient: QueryClient;
}

export interface SignInSearch {
  reason?: 'idle';
}

export function createAppRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in',
    validateSearch: (search: Record<string, unknown>): SignInSearch =>
      search.reason === 'idle' ? { reason: 'idle' } : {},
    component: function SignInRoute() {
      const { reason } = signInRoute.useSearch();
      return <SignInPage idle={reason === 'idle'} />;
    },
  });

  const mfaCheckRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in/verify',
    component: MfaCheckPage,
  });

  const mfaSetupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mfa/setup',
    beforeLoad: async ({ context }) => {
      try {
        const me = await fetchMe(context.queryClient);
        if (me.mfaEnrolled) throw redirect({ to: '/' });
      } catch (err) {
        if (isUnauthorized(err)) throw redirect({ to: '/sign-in' });
        throw err;
      }
    },
    component: MfaSetupPage,
  });

  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'shell',
    beforeLoad: async ({ context }) => {
      const wasSignedIn = context.queryClient.getQueryData(ME_KEY) !== undefined;
      try {
        const me = await fetchMe(context.queryClient);
        if (!me.mfaEnrolled) throw redirect({ to: '/mfa/setup' });
        return { me };
      } catch (err) {
        if (isUnauthorized(err)) {
          context.queryClient.clear();
          throw redirect({ to: '/sign-in', search: wasSignedIn ? { reason: 'idle' } : {} });
        }
        throw err;
      }
    },
    component: AppShell,
  });

  const homeRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/',
    component: HomePage,
  });

  const screenRoutes = SCREENS.map((screen) =>
    createRoute({
      getParentRoute: () => shellRoute,
      path: screen.path,
      component: () => <ScreenPage screen={screen} />,
    }),
  );

  const routeTree = rootRoute.addChildren([
    signInRoute,
    mfaCheckRoute,
    mfaSetupRoute,
    shellRoute.addChildren([homeRoute, ...screenRoutes]),
  ]);

  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
