import { useSearchParamsState } from 'react-design-kit';

/**
 * Matches the backend's default per-host Android capture cap
 * (ANDROID_STREAM_CAP) — MJPEG is a paced screencap loop, not a real video
 * encoder, and each additional simultaneous capture on one host degrades
 * shared adb-server/CPU/I/O. Raise only once H264 is verified on real
 * hardware (see docs/architecture-blueprint.md's streaming risk review).
 */
export const MULTI_VIEW_MAX = 3;

/**
 * URL-synced set of devices selected for the multi-view grid (same idiom as
 * useDeviceFilters — guidelines §10), stored as one comma-joined param
 * rather than a repeated-key array param, matching the rest of this app's
 * single-param-per-filter convention.
 */
export function useMultiViewSelection() {
  const [raw, setRaw] = useSearchParamsState('udids', '');
  const selected = raw ? raw.split(',').filter(Boolean) : [];

  function toggle(udid: string) {
    if (selected.includes(udid)) {
      setRaw(selected.filter((u) => u !== udid).join(','));
    } else if (selected.length < MULTI_VIEW_MAX) {
      setRaw([...selected, udid].join(','));
    }
  }

  function remove(udid: string) {
    setRaw(selected.filter((u) => u !== udid).join(','));
  }

  function clear() {
    setRaw('');
  }

  return { selected, toggle, remove, clear, atMax: selected.length >= MULTI_VIEW_MAX };
}
