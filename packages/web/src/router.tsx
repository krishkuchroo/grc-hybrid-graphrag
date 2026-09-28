// The app's routes (TanStack Router, browser history).
// - /sign-in, /sign-in/verify (the second factor) and /mfa/setup are the signed-out screens.
// - Every other screen sits inside the shell, which asks the API who is signed in on every move
//   between screens. A 401 there sends the person to sign-in; if they were signed in a moment ago,
//   the session ended while they were away, and sign-in says so.
// - /risks is the Risk register (its filters in the search params), /risks/new the create form and
//   /risks/$id a risk's page (S1-006). /controls, /policies, /assets and /incidents follow the same
//   shape (S1-007). The other screens show their empty state until their slice.
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
import { NewRiskPage, RiskPage } from '@/features/records/risks/RiskPage';
import { RiskRegister, validateRiskSearch } from '@/features/records/risks/RiskRegister';
import { AssetList, validateAssetSearch } from '@/features/records/assets/AssetList';
import { AssetPage, NewAssetPage } from '@/features/records/assets/AssetPage';
import { ControlList, validateControlSearch } from '@/features/records/controls/ControlList';
import { ControlPage, NewControlPage } from '@/features/records/controls/ControlPage';
import { IncidentList, validateIncidentSearch } from '@/features/records/incidents/IncidentList';
import { IncidentPage, NewIncidentPage } from '@/features/records/incidents/IncidentPage';
import { PolicyList, validatePolicySearch } from '@/features/records/policies/PolicyList';
import { NewPolicyPage, PolicyPage } from '@/features/records/policies/PolicyPage';
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

  const risksRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/risks',
    validateSearch: validateRiskSearch,
    component: function RisksRoute() {
      const search = risksRoute.useSearch();
      const navigate = risksRoute.useNavigate();
      return <RiskRegister search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
    },
  });

  const newRiskRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/risks/new',
    component: NewRiskPage,
  });

  const riskRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/risks/$id',
    component: function RiskRoute() {
      const { id } = riskRoute.useParams();
      return <RiskPage key={id} id={id} />;
    },
  });

  const controlsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/controls',
    validateSearch: validateControlSearch,
    component: function ControlsRoute() {
      const search = controlsRoute.useSearch();
      const navigate = controlsRoute.useNavigate();
      return <ControlList search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
    },
  });
  const newControlRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/controls/new',
    component: NewControlPage,
  });
  const controlRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/controls/$id',
    component: function ControlRoute() {
      const { id } = controlRoute.useParams();
      return <ControlPage key={id} id={id} />;
    },
  });

  const policiesRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/policies',
    validateSearch: validatePolicySearch,
    component: function PoliciesRoute() {
      const search = policiesRoute.useSearch();
      const navigate = policiesRoute.useNavigate();
      return <PolicyList search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
    },
  });
  const newPolicyRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/policies/new',
    component: NewPolicyPage,
  });
  const policyRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/policies/$id',
    component: function PolicyRoute() {
      const { id } = policyRoute.useParams();
      return <PolicyPage key={id} id={id} />;
    },
  });

  const assetsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/assets',
    validateSearch: validateAssetSearch,
    component: function AssetsRoute() {
      const search = assetsRoute.useSearch();
      const navigate = assetsRoute.useNavigate();
      return <AssetList search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
    },
  });
  const newAssetRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/assets/new',
    component: NewAssetPage,
  });
  const assetRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/assets/$id',
    component: function AssetRoute() {
      const { id } = assetRoute.useParams();
      return <AssetPage key={id} id={id} />;
    },
  });

  const incidentsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/incidents',
    validateSearch: validateIncidentSearch,
    component: function IncidentsRoute() {
      const search = incidentsRoute.useSearch();
      const navigate = incidentsRoute.useNavigate();
      return <IncidentList search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
    },
  });
  const newIncidentRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/incidents/new',
    component: NewIncidentPage,
  });
  const incidentRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/incidents/$id',
    component: function IncidentRoute() {
      const { id } = incidentRoute.useParams();
      return <IncidentPage key={id} id={id} />;
    },
  });

  const RECORD_SCREENS = new Set(['/risks', '/controls', '/policies', '/assets', '/incidents']);
  const screenRoutes = SCREENS.filter((screen) => !RECORD_SCREENS.has(screen.path)).map((screen) =>
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
    shellRoute.addChildren([
      homeRoute,
      risksRoute,
      newRiskRoute,
      riskRoute,
      controlsRoute,
      newControlRoute,
      controlRoute,
      policiesRoute,
      newPolicyRoute,
      policyRoute,
      assetsRoute,
      newAssetRoute,
      assetRoute,
      incidentsRoute,
      newIncidentRoute,
      incidentRoute,
      ...screenRoutes,
    ]),
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
