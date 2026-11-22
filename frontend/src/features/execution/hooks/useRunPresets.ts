import { useCallback, useState } from 'react';

/** `mh_` prefix matches the naming already used for `services/api.ts`'s `TOKEN_STORAGE_KEY`. */
const STORAGE_KEY = 'mh_execution_presets';

export interface RunPreset {
  id: string;
  name: string;
  project: string;
  branch: string;
  variant?: string;
  suite: string;
  /**
   * Host of the saved device. Optional only because presets saved before
   * device identity became host-scoped carry a udid alone — see
   * `resolvePresetDevice` for how those still load.
   */
  machineId?: string;
  deviceUdid: string;
  setupCmd: string;
  runCmd: string;
  savedAt: string;
}

export type RunPresetInput = Omit<RunPreset, 'id' | 'savedAt'>;

/**
 * The device a preset points at, or undefined when it can't be pinned down.
 * A udid alone isn't a device (emulator serials repeat across hosts), so a
 * legacy preset without a host resolves only when exactly one device has that
 * udid — with two candidates it stays unselected rather than guessing a host.
 */
export function resolvePresetDevice<D extends { machineId: string; udid: string }>(
  preset: Pick<RunPreset, 'machineId' | 'deviceUdid'>,
  devices: readonly D[],
): D | undefined {
  if (!preset.deviceUdid) return undefined;
  if (preset.machineId) {
    return devices.find((d) => d.machineId === preset.machineId && d.udid === preset.deviceUdid);
  }
  const matches = devices.filter((d) => d.udid === preset.deviceUdid);
  return matches.length === 1 ? matches[0] : undefined;
}

function readPresets(): RunPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunPreset[]) : [];
  } catch {
    return [];
  }
}

function writePresets(presets: RunPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Best-effort only (private browsing / full quota) — losing a preset save
    // shouldn't break the trigger form.
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Named snapshots of the trigger form's real fields (project/branch/suite/
 * device/setup/run), stored client-side only. There is no user-preset
 * backend endpoint (confirmed against `execution.routes.ts`) and this task
 * deliberately doesn't add one, so presets live in `localStorage` and are
 * per-browser, not shared across sessions or users.
 */
export function useRunPresets() {
  const [presets, setPresets] = useState<RunPreset[]>(() => readPresets());

  const savePreset = useCallback((input: RunPresetInput) => {
    setPresets((prev) => {
      // Saving under a name that already exists overwrites it, rather than
      // silently accumulating duplicates.
      const next = [
        ...prev.filter((p) => p.name !== input.name),
        { ...input, id: generateId(), savedAt: new Date().toISOString() },
      ].sort((a, b) => a.name.localeCompare(b.name));
      writePresets(next);
      return next;
    });
  }, []);

  const deletePreset = useCallback((id: string) => {
    setPresets((prev) => {
      const next = prev.filter((p) => p.id !== id);
      writePresets(next);
      return next;
    });
  }, []);

  return { presets, savePreset, deletePreset };
}
