import { useCallback, useState } from 'react';

/** `mh_` prefix matches the naming already used for `services/api.ts`'s `TOKEN_STORAGE_KEY`. */
const STORAGE_KEY = 'mh_execution_presets';

export interface RunPreset {
  id: string;
  name: string;
  project: string;
  branch: string;
  suite: string;
  deviceUdid: string;
  setupCmd: string;
  runCmd: string;
  savedAt: string;
}

export type RunPresetInput = Omit<RunPreset, 'id' | 'savedAt'>;

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
