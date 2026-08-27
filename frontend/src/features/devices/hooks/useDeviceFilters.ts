import { useSearchParamsState } from 'react-design-kit';
import type { DevicePlatformFilter, DeviceStatusFilter } from '../components/DeviceFilterBar';

/**
 * URL-synced device filters (guidelines §10: "Filters URL-synced"). Backed by
 * the same query params `GET /api/devices` already accepts server-side
 * (`status`, `platform`) — filtering happens on the backend, not by hiding
 * cards client-side, so the count in the URL matches what was actually
 * fetched.
 */
export function useDeviceFilters() {
  const [status, setStatus] = useSearchParamsState('status', 'all');
  const [platform, setPlatform] = useSearchParamsState('platform', 'all');
  return {
    status: status as DeviceStatusFilter,
    setStatus: (v: DeviceStatusFilter) => setStatus(v),
    platform: platform as DevicePlatformFilter,
    setPlatform: (v: DevicePlatformFilter) => setPlatform(v),
  };
}
