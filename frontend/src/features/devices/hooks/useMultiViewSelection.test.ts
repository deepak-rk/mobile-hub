import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMultiViewSelection, MULTI_VIEW_MAX } from './useMultiViewSelection';

// useSearchParamsState (react-design-kit) reads/writes window.location directly,
// no router needed — but state leaks across tests via the real URL unless reset.
beforeEach(() => {
  window.history.replaceState(null, '', '/devices/multi-view');
});

describe('useMultiViewSelection', () => {
  it('starts with nothing selected', () => {
    const { result } = renderHook(() => useMultiViewSelection());
    expect(result.current.selected).toEqual([]);
    expect(result.current.atMax).toBe(false);
  });

  it('toggle adds and then removes a device', () => {
    const { result } = renderHook(() => useMultiViewSelection());

    act(() => result.current.toggle('device-1'));
    expect(result.current.selected).toEqual(['device-1']);

    act(() => result.current.toggle('device-1'));
    expect(result.current.selected).toEqual([]);
  });

  it('toggle refuses to add past MULTI_VIEW_MAX', () => {
    const { result } = renderHook(() => useMultiViewSelection());

    // Each toggle is its own act() so the hook re-renders (and `selected`
    // updates) between calls, matching real usage — one call per click, not
    // a synchronous loop where every call would otherwise close over the
    // same stale `selected` from before any of them committed.
    for (let i = 0; i < MULTI_VIEW_MAX + 2; i++) {
      act(() => result.current.toggle(`device-${i}`));
    }

    expect(result.current.selected).toHaveLength(MULTI_VIEW_MAX);
    expect(result.current.selected).toEqual(['device-0', 'device-1', 'device-2']);
    expect(result.current.atMax).toBe(true);
  });

  it('remove drops one device without affecting the rest', () => {
    const { result } = renderHook(() => useMultiViewSelection());
    act(() => result.current.toggle('device-1'));
    act(() => result.current.toggle('device-2'));

    act(() => result.current.remove('device-1'));

    expect(result.current.selected).toEqual(['device-2']);
  });

  it('clear empties the whole selection', () => {
    const { result } = renderHook(() => useMultiViewSelection());
    act(() => result.current.toggle('device-1'));
    act(() => result.current.toggle('device-2'));

    act(() => result.current.clear());

    expect(result.current.selected).toEqual([]);
  });

  it('selectMany replaces the whole selection, truncated to MULTI_VIEW_MAX', () => {
    const { result } = renderHook(() => useMultiViewSelection());
    act(() => result.current.toggle('stale-device'));

    const many = Array.from({ length: MULTI_VIEW_MAX + 3 }, (_, i) => `online-${i}`);
    act(() => result.current.selectMany(many));

    expect(result.current.selected).toEqual(many.slice(0, MULTI_VIEW_MAX));
    expect(result.current.selected).not.toContain('stale-device');
  });

  it('selectMany with fewer devices than the cap keeps them all', () => {
    const { result } = renderHook(() => useMultiViewSelection());
    act(() => result.current.selectMany(['a', 'b']));
    expect(result.current.selected).toEqual(['a', 'b']);
  });
});
