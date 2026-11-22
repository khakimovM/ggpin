import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage';
import { useAdmin } from './admin-context';
import { NotFoundPage } from './pages/NotFoundPage';
import { RequireAdmin } from './RequireAdmin';
import { RootLayout } from './RootLayout';
import { screenRoutes } from './screens';
import { homePathFor } from './sections';
import { AppShell } from './shell/AppShell';

function HomeRedirect() {
  const me = useAdmin();
  return <Navigate to={homePathFor(me.permissions)} replace />;
}

// The theme probe of e2e/theme.spec.ts exists only on the dev server: in a production build the
// branch is dead code and the page module is not emitted (scripts/prod-build-check.mjs). It stays
// lazy for that reason; opening it first needs a HydrateFallback while the module loads (blank:
// the probe is a test page, and it loads in milliseconds from the dev server).
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: 'dev/theme-probe',
        HydrateFallback: () => null,
        lazy: async () => {
          const { ThemeProbePage } = await import('./pages/ThemeProbePage');
          return { Component: ThemeProbePage };
        },
      },
    ]
  : [];

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      ...devRoutes,
      {
        element: (
          <RequireAdmin>
            <AppShell />
          </RequireAdmin>
        ),
        children: [
          { index: true, element: <HomeRedirect /> },
          ...screenRoutes,
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createAdminRouter() {
  return createBrowserRouter(routes);
}
