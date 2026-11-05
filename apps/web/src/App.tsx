/**
 * Routes (integrator-owned). Pages live in src/pages/<Name>.tsx — one owner per page (CONTRACT.md §2).
 * AuthGate: redirects to /setup when no owner exists, /login when signed out.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { AuthState } from '@docksy/shared';
import { useApi } from './lib/api.ts';
import { Loading } from './components/ui.tsx';
import Layout from './components/Layout.tsx';

const Login = lazy(() => import('./pages/Login.tsx'));
const Setup = lazy(() => import('./pages/Setup.tsx'));
const Overview = lazy(() => import('./pages/Overview.tsx'));
const Servers = lazy(() => import('./pages/Servers.tsx'));
const NewServer = lazy(() => import('./pages/NewServer.tsx'));
const ServerDetail = lazy(() => import('./pages/ServerDetail.tsx'));
const Alerts = lazy(() => import('./pages/Alerts.tsx'));
const Uptime = lazy(() => import('./pages/Uptime.tsx'));
const StatusPage = lazy(() => import('./pages/StatusPage.tsx'));
const Apps = lazy(() => import('./pages/Apps.tsx'));
const NewApp = lazy(() => import('./pages/NewApp.tsx'));
const AppDetail = lazy(() => import('./pages/AppDetail.tsx'));
const DeploymentDetail = lazy(() => import('./pages/DeploymentDetail.tsx'));
const Claude = lazy(() => import('./pages/Claude.tsx'));
const Settings = lazy(() => import('./pages/Settings.tsx'));
const NotFound = lazy(() => import('./pages/NotFound.tsx'));

function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useApi<AuthState>('/auth/state', { key: ['/auth/state'] });
  const loc = useLocation();
  if (isLoading || !data) return <Loading />;
  if (data.setupRequired) return <Navigate to="/setup" replace />;
  if (!data.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/status" element={<StatusPage />} />
        <Route element={<AuthGate><Layout /></AuthGate>}>
          <Route index element={<Overview />} />
          <Route path="servers" element={<Servers />} />
          <Route path="servers/new" element={<NewServer />} />
          <Route path="servers/:id" element={<ServerDetail />} />
          <Route path="apps" element={<Apps />} />
          <Route path="apps/new" element={<NewApp />} />
          <Route path="apps/:id" element={<AppDetail />} />
          <Route path="deployments/:id" element={<DeploymentDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="uptime" element={<Uptime />} />
          <Route path="claude" element={<Claude />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
