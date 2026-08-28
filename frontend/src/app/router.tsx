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
import { ServersPage } from '@/features/servers/pages/ServersPage';
import { AgentCredentialsPage } from '@/features/agent-credentials/pages/AgentCredentialsPage';

// Reads are public (the backend leaves list routes unauthenticated), so the
// app shell is reachable signed-out and only *actions* are gated. Signing in
// unlocks them in place rather than gating the whole product behind a wall.
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'devices/multi-view', element: <MultiDeviceViewPage /> },
      { path: 'devices/:udid', element: <DeviceViewerPage /> },
      { path: 'builds', element: <BuildsPage /> },
      { path: 'execution', element: <RunListPage /> },
      { path: 'execution/new', element: <TriggerRunPage /> },
      { path: 'execution/:runId', element: <RunDetailPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'servers', element: <ServersPage /> },
      { path: 'agent-credentials', element: <AgentCredentialsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
