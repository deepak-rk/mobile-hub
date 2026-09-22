import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeviceStream } from './useDeviceStream';
import { TOKEN_STORAGE_KEY } from '@/services/api';

/**
 * Regression for the tab-visibility-pause gap: a backgrounded tab kept its
 * socket open indefinitely, burning host capture/bandwidth for a stream
 * nobody was looking at. The fix folds `document.visibilityState` into the
 * same `enabled`-driven url gate this hook already had, so `useResilientWebSocket`
 * receives `url: null` while hidden — reusing its existing teardown path
 * rather than adding a second one.
 */
let capturedUrl: string | null = null;

vi.mock('use-resilient-websocket', () => ({
  buildSocketUrl: (path: string) => path,
  useObjectUrl: () => ({ url: null, setFromBlob: vi.fn() }),
  useResilientWebSocket: (opts: { url: string | null }) => {
    capturedUrl = opts.url;
    return { state: opts.url ? 'connecting' : 'idle', closeCode: null, closeReason: null };
  },
}));

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useDeviceStream — tab-visibility pause', () => {
  beforeEach(() => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'fake-token');
    setVisibility('visible');
    capturedUrl = null;
  });

  afterEach(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  });

  it('connects (passes a real url to the transport) while the tab is visible', () => {
    renderHook(() => useDeviceStream('emulator-5554', true));
    expect(capturedUrl).not.toBeNull();
  });

  it('disconnects (passes url: null) once the tab is backgrounded', () => {
    renderHook(() => useDeviceStream('emulator-5554', true));
    expect(capturedUrl).not.toBeNull();

    act(() => setVisibility('hidden'));
    expect(capturedUrl).toBeNull();
  });

  it('reconnects when the tab comes back to the foreground', () => {
    renderHook(() => useDeviceStream('emulator-5554', true));
    act(() => setVisibility('hidden'));
    expect(capturedUrl).toBeNull();

    act(() => setVisibility('visible'));
    expect(capturedUrl).not.toBeNull();
  });

  it('reports the honest "idle" state while paused, not "unauthenticated"', () => {
    const { result } = renderHook(() => useDeviceStream('emulator-5554', true));
    act(() => setVisibility('hidden'));
    expect(result.current.state).toBe('idle');
  });
});
