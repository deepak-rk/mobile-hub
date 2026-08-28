import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Dialog, EmptyState, Field } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDevices } from '@/features/devices/api/devices.api';
import { useTriggerRun } from '../api/execution.api';
import { useRunPresets } from '../hooks/useRunPresets';
import styles from './TriggerRunForm.module.css';

/** Splits a command string into argv without pretending to be a real shell. */
function parseCommand(input: string): { command: string; args: string[] } | null {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * The trigger form, extracted from the old standalone `TriggerRunPage` so it
 * can live inside the unified pipeline page's "Trigger" tab. `/execution/new`
 * still exists as a route (router.tsx is out of scope for this change) and
 * now just redirects here — see `TriggerRunPage.tsx`.
 */
export function TriggerRunForm() {
  const { user, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const trigger = useTriggerRun();
  const { data: devices } = useDevices();
  const { presets, savePreset, deletePreset } = useRunPresets();

  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('main');
  const [suite, setSuite] = useState('');
  const [deviceUdid, setDeviceUdid] = useState('');
  const [setupCmd, setSetupCmd] = useState('');
  const [runCmd, setRunCmd] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState('');

  if (!user) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.locked}
            title="Sign in to trigger a run"
            body="Dispatching a run requires an operator or admin session."
            action={{ label: 'Sign in', onClick: () => navigate('/login', { state: { from: location.pathname } }) }}
          />
        </CardBody>
      </Card>
    );
  }

  if (!can('operator', 'admin')) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.locked}
            title="Not permitted"
            body={`Triggering a run requires the operator or admin role. Your account is "${user.role}".`}
          />
        </CardBody>
      </Card>
    );
  }

  // Only devices that can actually take a run — the backend rejects a locked
  // device with 409, so offering one would just produce a confusing failure.
  const availableDevices = devices?.filter((d) => !d.lock && d.status !== 'offline' && d.status !== 'unreachable');

  function applyPreset(id: string) {
    setSelectedPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setProject(preset.project);
    setBranch(preset.branch);
    setSuite(preset.suite);
    setSetupCmd(preset.setupCmd);
    setRunCmd(preset.runCmd);
    // Only carry the device over if it's still eligible right now — a saved
    // preset shouldn't silently point at a device that's since gone offline
    // or been locked by someone else.
    const stillAvailable = availableDevices?.some((d) => d.udid === preset.deviceUdid);
    setDeviceUdid(stillAvailable ? preset.deviceUdid : '');
  }

  function onSavePreset(e: FormEvent) {
    e.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    savePreset({ name, project: project.trim(), branch: branch.trim(), suite: suite.trim(), deviceUdid, setupCmd, runCmd });
    setPresetName('');
    setPresetDialogOpen(false);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const run = parseCommand(runCmd);
    if (!run) {
      setFormError('A run command is required.');
      return;
    }
    const device = devices?.find((d) => d.udid === deviceUdid);
    if (!device) {
      setFormError('Select a device.');
      return;
    }

    trigger.mutate(
      {
        machineId: device.machineId,
        deviceUdid: device.udid,
        project: project.trim(),
        branch: branch.trim(),
        suite: suite.trim(),
        setup: parseCommand(setupCmd) ?? undefined,
        run,
      },
      { onSuccess: (created) => navigate(`/execution/${created._id}`) },
    );
  }

  const apiError = trigger.error as ApiError | null;

  return (
    <Card>
      <CardBody>
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.presetRow}>
            <label className={styles.field}>
              <span className={styles.label}>Preset</span>
              <select
                className={styles.select}
                value={selectedPresetId}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">
                  {presets.length === 0 ? 'No saved presets yet' : 'Load a saved preset…'}
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.presetActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPresetName('');
                  setPresetDialogOpen(true);
                }}
              >
                <icons.presetSave size={iconSize.control} aria-hidden="true" />
                Save as preset
              </Button>
              {selectedPresetId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Delete selected preset"
                  onClick={() => {
                    deletePreset(selectedPresetId);
                    setSelectedPresetId('');
                  }}
                >
                  <icons.remove size={iconSize.control} aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>

          <div className={styles.row}>
            <Field label="Project" value={project} required onChange={(e) => setProject(e.target.value)} />
            <Field label="Branch" value={branch} required onChange={(e) => setBranch(e.target.value)} />
          </div>

          <div className={styles.row}>
            <Field label="Suite" value={suite} required onChange={(e) => setSuite(e.target.value)} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="device">
                Device ({availableDevices?.length ?? 0})
              </label>
              <select
                id="device"
                className={styles.select}
                value={deviceUdid}
                required
                onChange={(e) => setDeviceUdid(e.target.value)}
              >
                <option value="">Select an available device…</option>
                {availableDevices?.map((d) => (
                  <option key={d._id} value={d.udid}>
                    {d.name} · {d.platform === 'ios' ? 'iOS' : 'Android'} {d.osVersion} · {d.machineId}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                {availableDevices?.length === 0
                  ? 'No devices are currently available — all are locked or offline.'
                  : 'Locked and offline devices are excluded.'}
              </span>
            </div>
          </div>

          <Field
            label="Setup command"
            value={setupCmd}
            placeholder="npm ci"
            hint="Optional. Runs before the suite, in the run's workspace."
            onChange={(e) => setSetupCmd(e.target.value)}
          />
          <Field
            label="Run command"
            value={runCmd}
            placeholder="npx wdio run wdio.conf.js"
            required
            hint="Executed directly — not through a shell, so pipes and redirects won't work."
            onChange={(e) => setRunCmd(e.target.value)}
          />

          {formError ?? apiError ? (
            <div className={styles.error} role="alert">
              {formError ?? apiError?.message ?? 'The run could not be started.'}
            </div>
          ) : null}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={trigger.isPending}>
              <icons.running size={iconSize.control} aria-hidden="true" />
              {trigger.isPending ? 'Starting…' : 'Start run'}
            </Button>
          </div>
        </form>
      </CardBody>

      <Dialog
        open={presetDialogOpen}
        onClose={() => setPresetDialogOpen(false)}
        title="Save preset"
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => setPresetDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="preset-name-form" variant="primary" disabled={!presetName.trim()}>
              Save
            </Button>
          </>
        }
      >
        <form id="preset-name-form" onSubmit={onSavePreset}>
          <Field
            label="Preset name"
            value={presetName}
            required
            autoFocus
            placeholder="e.g. nightly-android-smoke"
            onChange={(e) => setPresetName(e.target.value)}
          />
        </form>
      </Dialog>
    </Card>
  );
}
