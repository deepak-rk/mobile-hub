import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { DevicesPage } from '@/features/devices/pages/DevicesPage';
import { DeviceViewerPage } from '@/features/devices/pages/DeviceViewerPage';
import { BuildsPage } from '@/features/builds/pages/BuildsPage';
import { RunListPage } from '@/features/execution/pages/RunListPage';
import { TriggerRunPage } from '@/features/execution/pages/TriggerRunPage';
import { RunDetailPage } from '@/features/execution/pages/RunDetailPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { ServersPage } from '@/features/servers/pages/ServersPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'devices/:udid', element: <DeviceViewerPage /> },
      { path: 'builds', element: <BuildsPage /> },
      { path: 'execution', element: <RunListPage /> },
      { path: 'execution/new', element: <TriggerRunPage /> },
      { path: 'execution/:runId', element: <RunDetailPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'servers', element: <ServersPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
