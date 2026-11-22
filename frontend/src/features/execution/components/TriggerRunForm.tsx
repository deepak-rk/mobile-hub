import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Dialog, EmptyState, Field } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDevices } from '@/features/devices/api/devices.api';
import { deviceKey } from '@/features/devices/lib/deviceKey';
import {
  useBranches,
  useProjects,
  useReloadConfig,
  useSuites,
  useTriggerRun,
} from '../api/execution.api';
import { resolvePresetDevice, useRunPresets } from '../hooks/useRunPresets';
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
  // Until someone picks a branch (or a preset does), follow the repo's own
  // default branch rather than assuming `main`.
  const [branchChosen, setBranchChosen] = useState(false);
  const [suite, setSuite] = useState('');
  const [variant, setVariant] = useState('');
  // Host + udid (`deviceKey`), not a bare udid: `emulator-5554` on two hosts
  // is two devices, and a udid-keyed picker would select both as one.
  const [selectedDeviceKey, setSelectedDeviceKey] = useState('');
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
  // One app per deployment: only declared projects are offered. Names that
  // exist only in run history stay in analytics filters, not here, since a
  // run against one would fall back to org defaults it never declared.
  const declaredProjects = projects?.filter((p) => p.declared) ?? [];
  const onlyProject = declaredProjects.length === 1 ? declaredProjects[0] : undefined;
  useEffect(() => {
    if (onlyProject && project === '') setProject(onlyProject.id);
  }, [onlyProject, project]);
  const selectedProject = projects?.find((p) => p.id === project);
  const variants = selectedProject?.variants ?? [];
  const platforms = selectedProject?.platforms ?? [];
  // Above the early returns below, not beside the field it feeds: hooks must
  // run in the same order on every render, and the sign-in and role guards
  // return before that point.
  // Suites are read from the chosen branch, since that is what the run executes.
  const {
    data: suiteData,
    isFetching: suitesLoading,
    error: suitesError,
  } = useSuites(configuredProject ? project : undefined, branch);
  const suites = suitesError ? undefined : suiteData?.suites;
  const suiteHint = suitesLoading
    ? 'Reading suites from the automation repo…'
    : suitesError
      ? `${(suitesError as ApiError).message ?? 'Could not read suites'} — type one.`
      : (suiteData?.unavailable ??
        (suites && suites.length === 0 ? 'No suites found in the repo — type one.' : ''));
  const { data: branchData, isFetching: branchesLoading } = useBranches(
    configuredProject ? project : undefined,
  );
  const branches = branchData?.branches;
  const branchHint = branchesLoading
    ? 'Reading branches from the remote…'
    : (branchData?.unavailable ??
      (branches && branches.length === 0 ? 'No branches found — type one.' : ''));
  const defaultBranch = branchData?.defaultBranch;
  useEffect(() => {
    if (!branchChosen && defaultBranch) setBranch(defaultBranch);
  }, [branchChosen, defaultBranch]);

  if (!user) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.locked}
            title="Sign in to trigger a run"
            body="Dispatching a run requires an operator or admin session."
            action={{
              label: 'Sign in',
              onClick: () => navigate('/login', { state: { from: location.pathname } }),
            }}
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
  // and only on a platform the app ships on: the backend rejects any other.
  const availableDevices = devices?.filter(
    (d) =>
      !d.lock &&
      d.status !== 'offline' &&
      d.status !== 'unreachable' &&
      (platforms.length === 0 || platforms.includes(d.platform)),
  );

  function applyPreset(id: string) {
    setSelectedPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setProject(preset.project);
    setBranch(preset.branch);
    setBranchChosen(true);
    setSuite(preset.suite);
    setVariant(preset.variant ?? '');
    setSetupCmd(preset.setupCmd);
    setRunCmd(preset.runCmd);
    // Resolved against every device, not just the available ones, so a legacy
    // udid-only preset can't look unique merely because the other host's
    // device with that udid happens to be locked right now. Then only carried
    // over if it's still eligible — a saved preset shouldn't silently point at
    // a device that's since gone offline or been locked by someone else.
    const device = resolvePresetDevice(preset, devices ?? []);
    const stillAvailable =
      device && availableDevices?.some((d) => deviceKey(d) === deviceKey(device));
    setSelectedDeviceKey(device && stillAvailable ? deviceKey(device) : '');
  }

  function onSavePreset(e: FormEvent) {
    e.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    const device = devices?.find((d) => deviceKey(d) === selectedDeviceKey);
    savePreset({
      name,
      project: project.trim(),
      branch: branch.trim(),
      ...(variant ? { variant } : {}),
      suite: suite.trim(),
      machineId: device?.machineId ?? '',
      deviceUdid: device?.udid ?? '',
      setupCmd,
      runCmd,
    });
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
    const device = devices?.find((d) => deviceKey(d) === selectedDeviceKey);
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
        // Only sent for a project that declares variants; a stale value from
        // a preset or another project would be a 400.
        variant: variants.includes(variant) ? variant : undefined,
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
              {onlyProject && project === onlyProject.id ? (
                <input
                  id="project"
                  className={styles.select}
                  value={onlyProject.displayName}
                  readOnly
                />
              ) : declaredProjects.length > 0 ? (
                <select
                  id="project"
                  className={styles.select}
                  value={project}
                  required
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">Select a project…</option>
                  {declaredProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
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
                  {reloadConfig.error instanceof Error
                    ? reloadConfig.error.message
                    : 'Config reload failed.'}
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
            <div className={styles.field}>
              <label className={styles.label} htmlFor="branch">
                Branch
              </label>
              {/* Same dropdown-or-free-text pattern as Suite below: a real
                  list once the remote can be read, free text (still
                  defaulting to "main") when it can't be — no repo
                  configured, or the remote couldn't be reached. */}
              {branches && branches.length > 0 ? (
                <select
                  id="branch"
                  className={styles.select}
                  value={branch}
                  required
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setBranchChosen(true);
                  }}
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="branch"
                  className={styles.select}
                  value={branch}
                  required
                  placeholder="e.g. main"
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setBranchChosen(true);
                  }}
                />
              )}
              {branchHint ? <span className={styles.hint}>{branchHint}</span> : null}
            </div>
          </div>

          {variants.length > 0 ? (
            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="variant">
                  Variant
                </label>
                <select
                  id="variant"
                  className={styles.select}
                  value={variants.includes(variant) ? variant : ''}
                  required
                  onChange={(e) => setVariant(e.target.value)}
                >
                  <option value="">Select a variant…</option>
                  {variants.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

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
                      {/* An unknown count is left off rather than shown as "0 features". */}
                      {s.kind === 'tag' && s.fileCount !== undefined
                        ? `${s.name} · ${s.fileCount} features`
                        : s.name}
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
                {/* No count until the list has loaded — "(0)" mid-fetch reads as a fact. */}
                Device{availableDevices ? ` (${availableDevices.length})` : ''}
              </label>
              <select
                id="device"
                className={styles.select}
                value={selectedDeviceKey}
                required
                onChange={(e) => setSelectedDeviceKey(e.target.value)}
              >
                <option value="">Select an available device…</option>
                {availableDevices?.map((d) => (
                  <option key={d._id} value={deviceKey(d)}>
                    {d.name} · {d.platform === 'ios' ? 'iOS' : 'Android'} {d.osVersion} ·{' '}
                    {d.machineId}
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

          {(formError ?? apiError) ? (
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
            <Button
              type="submit"
              form="preset-name-form"
              variant="primary"
              disabled={!presetName.trim()}
            >
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
