import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, EmptyState, Field, Page, PageHeader } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDevices } from '@/features/devices/api/devices.api';
import { useTriggerRun } from '../api/execution.api';
import styles from './TriggerRunPage.module.css';

/** Splits a command string into argv without pretending to be a real shell. */
function parseCommand(input: string): { command: string; args: string[] } | null {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { command: parts[0], args: parts.slice(1) };
}

export function TriggerRunPage() {
  const { user, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const trigger = useTriggerRun();
  const { data: devices } = useDevices();

  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('main');
  const [suite, setSuite] = useState('');
  const [deviceUdid, setDeviceUdid] = useState('');
  const [setupCmd, setSetupCmd] = useState('');
  const [runCmd, setRunCmd] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const backLink = (
    <Link to="/execution">
      <Button size="sm" variant="ghost">
        Back to runs
      </Button>
    </Link>
  );

  if (!user) {
    return (
      <Page>
        <PageHeader title="Trigger a run" actions={backLink} />
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
      </Page>
    );
  }

  if (!can('operator', 'admin')) {
    return (
      <Page>
        <PageHeader title="Trigger a run" actions={backLink} />
        <Card>
          <CardBody>
            <EmptyState
              icon={icons.locked}
              title="Not permitted"
              body={`Triggering a run requires the operator or admin role. Your account is "${user.role}".`}
            />
          </CardBody>
        </Card>
      </Page>
    );
  }

  // Only devices that can actually take a run — the backend rejects a locked
  // device with 409, so offering one would just produce a confusing failure.
  const availableDevices = devices?.filter((d) => !d.lock && d.status !== 'offline' && d.status !== 'unreachable');

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
    <Page>
      <PageHeader
        title="Trigger a run"
        subtitle="Dispatch a test suite to an available device."
        actions={backLink}
      />

      <Card>
        <CardBody>
          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <div className={styles.row}>
              <Field label="Project" value={project} required onChange={(e) => setProject(e.target.value)} />
              <Field label="Branch" value={branch} required onChange={(e) => setBranch(e.target.value)} />
            </div>

            <div className={styles.row}>
              <Field label="Suite" value={suite} required onChange={(e) => setSuite(e.target.value)} />
              <div className={styles.field}>
                <label className={styles.label} htmlFor="device">
                  Device
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
      </Card>
    </Page>
  );
}
