import { useSearchParamsState } from 'react-design-kit';

/** Grid gets unwieldy and each tile is a real capture on some host — keep it sane client-side. */
export const MULTI_VIEW_MAX = 6;

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
