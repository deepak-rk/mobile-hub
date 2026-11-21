import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { DevicesPage } from '@/features/devices/pages/DevicesPage';
import { DeviceViewerPage } from '@/features/devices/pages/DeviceViewerPage';
import { MultiDeviceViewPage } from '@/features/devices/pages/MultiDeviceViewPage';
import { BuildsPage } from '@/features/builds/pages/BuildsPage';
import { RunListPage } from '@/features/execution/pages/RunListPage';
import { TriggerRunPage } from '@/features/execution/pages/TriggerRunPage';
import { RunDetailPage } from '@/features/execution/pages/RunDetailPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { HostsPage } from '@/features/hosts/pages/HostsPage';
import { AgentCredentialsPage } from '@/features/agent-credentials/pages/AgentCredentialsPage';
import { FeatureGate } from '@/features/config/components/FeatureGate';

// Reads are public (the backend leaves list routes unauthenticated), so the
// app shell is reachable signed-out and only *actions* are gated. Signing in
// unlocks them in place rather than gating the whole product behind a wall.
// Modules an org can switch off (features.* in org config) sit behind
// FeatureGate, so a direct visit says "disabled" rather than erroring.
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: 'devices', element: <DevicesPage /> },
      {
        path: 'devices/multi-view',
        element: (
          <FeatureGate feature="streaming">
            <MultiDeviceViewPage />
          </FeatureGate>
        ),
      },
      { path: 'devices/:udid', element: <DeviceViewerPage /> },
      {
        path: 'builds',
        element: (
          <FeatureGate feature="builds">
            <BuildsPage />
          </FeatureGate>
        ),
      },
      {
        path: 'execution',
        element: (
          <FeatureGate feature="execution">
            <RunListPage />
          </FeatureGate>
        ),
      },
      {
        path: 'execution/new',
        element: (
          <FeatureGate feature="execution">
            <TriggerRunPage />
          </FeatureGate>
        ),
      },
      {
        path: 'execution/:runId',
        element: (
          <FeatureGate feature="execution">
            <RunDetailPage />
          </FeatureGate>
        ),
      },
      {
        path: 'analytics',
        element: (
          <FeatureGate feature="analytics">
            <AnalyticsPage />
          </FeatureGate>
        ),
      },
      { path: 'hosts', element: <HostsPage /> },
      { path: 'agent-credentials', element: <AgentCredentialsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
