import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Dialog, EmptyState, Field } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDevices } from '@/features/devices/api/devices.api';
import { useProjects, useReloadConfig, useSuites, useTriggerRun } from '../api/execution.api';
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
  // Polled, not fetched once: a device locked by a run that has since finished
  // must reappear here without the user reloading the page. Lock/unlock done
  // in this browser already invalidates the query, but a lock released by the
  // backend — a run ending, or the TTL sweep — has no client event to hang off.
  const { data: devices } = useDevices(undefined, { refetchInterval: 5000 });
  const { data: projects } = useProjects();
  const reloadConfig = useReloadConfig();
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

  // A declared project carries its own automation config, so the backend can
  // build the commands. One known only from run history cannot, and still
  // needs a command typed in.
  const configuredProject = projects?.find((p) => p.id === project)?.declared ?? false;
  // Above the early returns below, not beside the field it feeds: hooks must
  // run in the same order on every render, and the sign-in and role guards
  // return before that point.
  const { data: suiteData, isFetching: suitesLoading } = useSuites(configuredProject ? project : undefined);
  const suites = suiteData?.suites;
  const suiteHint = suitesLoading
    ? 'Reading suites from the automation repo…'
    : (suiteData?.unavailable ?? (suites && suites.length === 0 ? 'No suites found in the repo — type one.' : ''));

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

    // No longer required: a configured project declares how it installs and
    // runs, and the backend derives both. Only a project that declares nothing
    // still needs a command typed here, and the backend says so with a 400
    // naming the two ways out.
    const run = parseCommand(runCmd);
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
        // Omitted rather than sent empty, so the backend falls back to the
        // project's configured command instead of being handed nothing.
        run: run ?? undefined,
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
            <div className={styles.field}>
              <div className={styles.labelRow}>
                <label className={styles.label} htmlFor="project">
                  Project
                </label>
                {/* Admin-only, and placed here rather than on a settings page
                    because this is where its absence is felt: an operator who
                    just declared a project in YAML comes looking for it in
                    this dropdown. Config is read at boot, so without this the
                    only way to see it is a backend restart — which drops every
                    live log stream and device capture. */}
                {can('admin') ? (
                  <button
                    type="button"
                    className={styles.inlineAction}
                    disabled={reloadConfig.isPending}
                    onClick={() => reloadConfig.mutate()}
                  >
                    {reloadConfig.isPending ? 'Reloading…' : 'Reload config'}
                  </button>
                ) : null}
              </div>
              {/* A dropdown once the backend knows of any project, but never a
                  dropdown with nothing in it: on a fresh install there are no
                  projects yet, and an empty select would block the very first
                  run. Free text is the honest fallback there. */}
              {projects && projects.length > 0 ? (
                <select
                  id="project"
                  className={styles.select}
                  value={project}
                  required
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {/* A project seen only in run history isn't configured,
                          so its automation falls back to org defaults — worth
                          saying, since that decides whether a repo gets cloned. */}
                      {p.displayName}
                      {p.declared ? '' : ' (not configured)'}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="project"
                  className={styles.select}
                  value={project}
                  required
                  placeholder="No projects configured yet — type one"
                  onChange={(e) => setProject(e.target.value)}
                />
              )}
              {/* Says what changed, not just that something did: "it
                  reloaded" does not tell the operator whether the block they
                  edited was the one that took. */}
              {reloadConfig.isError ? (
                <span className={styles.hintError}>
                  {reloadConfig.error instanceof Error ? reloadConfig.error.message : 'Config reload failed.'}
                </span>
              ) : reloadConfig.isSuccess ? (
                <span className={styles.hint}>
                  {reloadConfig.data.projects.added.length > 0
                    ? `Added ${reloadConfig.data.projects.added.join(', ')}.`
                    : reloadConfig.data.projects.removed.length > 0
                      ? `Removed ${reloadConfig.data.projects.removed.join(', ')}.`
                      : `Config reloaded — ${reloadConfig.data.projects.total} project(s), unchanged.`}
                </span>
              ) : null}
            </div>
            <Field label="Branch" value={branch} required onChange={(e) => setBranch(e.target.value)} />
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="suite">
                Suite
              </label>
              {/* A dropdown once the project's repo has been read. Falls back
                  to free text when it can't be — no repo configured, an
                  unknown framework, or a repo that simply has no feature
                  files — with the reason shown rather than an empty select. */}
              {suites && suites.length > 0 ? (
                <select
                  id="suite"
                  className={styles.select}
                  value={suite}
                  required
                  onChange={(e) => setSuite(e.target.value)}
                >
                  <option value="">Select a suite…</option>
                  {suites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === 'tag' ? `${s.name} · ${s.fileCount ?? 0} features` : s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="suite"
                  className={styles.select}
                  value={suite}
                  required
                  placeholder={project ? 'Type a suite name' : 'Pick a project first'}
                  onChange={(e) => setSuite(e.target.value)}
                />
              )}
              {suiteHint ? <span className={styles.hint}>{suiteHint}</span> : null}
            </div>
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
            label="Setup command (override)"
            value={setupCmd}
            placeholder={configuredProject ? 'From project config' : 'npm ci'}
            hint="Leave blank to use the project's configured install step."
            onChange={(e) => setSetupCmd(e.target.value)}
          />
          <Field
            label="Run command (override)"
            value={runCmd}
            placeholder={configuredProject ? 'From project config' : 'npx wdio run wdio.conf.js'}
            hint={
              configuredProject
                ? "Leave blank — this project's framework and config file decide how the suite runs."
                : 'This project is not configured, so a command is required. Executed directly, not through a shell.'
            }
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
