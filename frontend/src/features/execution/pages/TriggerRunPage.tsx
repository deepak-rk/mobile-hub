import { Navigate } from 'react-router-dom';

/**
 * The trigger form now lives on the "Trigger" tab of the unified pipeline
 * page (`RunListPage`) — see design-gap review point 1. This route
 * (`/execution/new`) still exists because `router.tsx` is out of scope for
 * this change, so it redirects rather than duplicating the form here.
 */
export function TriggerRunPage() {
  return <Navigate to="/execution?tab=trigger" replace />;
}
