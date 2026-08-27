import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  Dialog,
  EmptyState,
  Field,
  Mono,
  Page,
  PageHeader,
  QueryBoundary,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  useToast,
} from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { formatRelative } from 'ts-format-utils';
import { useAgentCredentials, useIssueAgentCredential, useRevokeAgentCredential } from '../api/agent-credentials.api';
import type { AgentCredential, IssuedAgentCredential } from '../types';
import styles from './AgentCredentialsPage.module.css';

export function AgentCredentialsPage() {
  const { user, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (!user) {
    return (
      <Page>
        <PageHeader title="Agent credentials" />
        <Card>
          <CardBody>
            <EmptyState
              icon={icons.credential}
              title="Sign in to manage agent credentials"
              body="Issuing and revoking the tokens device agents authenticate with requires an admin session."
              action={{ label: 'Sign in', onClick: () => navigate('/login', { state: { from: location.pathname } }) }}
            />
          </CardBody>
        </Card>
      </Page>
    );
  }

  if (!can('admin')) {
    return (
      <Page>
        <PageHeader title="Agent credentials" />
        <Card>
          <CardBody>
            <EmptyState
              icon={icons.credential}
              title="Not permitted"
              body={`Managing agent credentials requires the admin role. Your account is "${user.role}".`}
            />
          </CardBody>
        </Card>
      </Page>
    );
  }

  return <AdminAgentCredentials />;
}

/**
 * Split out from the gate above so `useAgentCredentials` — a real request
 * against an admin-only endpoint — is never even attempted for a signed-out
 * or non-admin visitor. Hooks can't be called conditionally, so the gate has
 * to happen by not rendering this component at all, not by branching inside it.
 */
function AdminAgentCredentials() {
  const { data: credentials, isPending, error, refetch } = useAgentCredentials();
  const issue = useIssueAgentCredential();
  const revoke = useRevokeAgentCredential();
  const { show } = useToast();

  const [showIssueForm, setShowIssueForm] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [label, setLabel] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // The raw token exists ONLY here, in memory, from the moment the issue
  // mutation resolves until this dialog is dismissed. It is never written to
  // the TanStack Query cache (useAgentCredentials only ever fetches the
  // redacted shape) and the backend never returns it again after this one
  // response — closing this dialog is the point of no return, same as a
  // GitHub PAT or a Stripe API key.
  const [issuedToken, setIssuedToken] = useState<IssuedAgentCredential | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentCredential | null>(null);
  const [copied, setCopied] = useState(false);

  function onIssueSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmedMachineId = machineId.trim();
    if (!trimmedMachineId) {
      setFormError('A machine ID is required.');
      return;
    }
    issue.mutate(
      { machineId: trimmedMachineId, label: label.trim() || undefined },
      {
        onSuccess: (result) => {
          setShowIssueForm(false);
          setMachineId('');
          setLabel('');
          setCopied(false);
          setIssuedToken(result);
        },
        onError: (err) => setFormError((err as ApiError).message ?? 'Failed to issue the credential.'),
      },
    );
  }

  function onCopyToken() {
    if (!issuedToken) return;
    void navigator.clipboard.writeText(issuedToken.rawToken).then(() => setCopied(true));
  }

  function onConfirmRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    revoke.mutate(target.id, {
      onSuccess: () => show(`Revoked the credential for ${target.machineId}`, { tone: 'success' }),
      onError: () => show(`Failed to revoke the credential for ${target.machineId}`, { tone: 'danger' }),
    });
  }

  return (
    <Page>
      <PageHeader
        title="Agent credentials"
        subtitle="Per-host tokens device agents present to the hub. Each is scoped to one machine and can be revoked on its own — a compromised host no longer means rotating every agent."
        actions={
          <Button variant="primary" size="sm" onClick={() => setShowIssueForm(true)}>
            <icons.credential size={iconSize.control} aria-hidden="true" />
            Issue credential
          </Button>
        }
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={credentials?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.credential}
            title="No agent credentials yet"
            body="Every device agent currently authenticates with the shared AGENT_TOKEN fallback. Issue a credential to scope one to a specific machine."
            action={{ label: 'Issue credential', onClick: () => setShowIssueForm(true) }}
          />
        }
      >
        <Table>
          <Thead>
            <Tr>
              <Th>Machine ID</Th>
              <Th>Label</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>{/* revoke action */}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {credentials?.map((cred) => (
              <Tr key={cred.id}>
                <Td>
                  <Mono>{cred.machineId}</Mono>
                </Td>
                <Td>{cred.label ?? <span className={styles.dash}>—</span>}</Td>
                <Td>
                  <StatusBadge status={cred.revokedAt ? 'revoked' : 'active'} bare />
                </Td>
                <Td>{formatRelative(cred.createdAt)}</Td>
                <Td>
                  {cred.revokedAt ? null : (
                    <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(cred)}>
                      Revoke
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </QueryBoundary>

      {/* Issue form */}
      <Dialog
        open={showIssueForm}
        onClose={() => setShowIssueForm(false)}
        title="Issue a new agent credential"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setShowIssueForm(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="issue-credential-form" disabled={issue.isPending}>
              {issue.isPending ? 'Issuing…' : 'Issue credential'}
            </Button>
          </>
        }
      >
        <form id="issue-credential-form" className={styles.form} onSubmit={onIssueSubmit} noValidate>
          <Field
            label="Machine ID"
            value={machineId}
            required
            hint="Must match the machineId this agent reports in its heartbeat."
            onChange={(e) => setMachineId(e.target.value)}
          />
          <Field
            label="Label"
            value={label}
            hint="Optional — a human-readable note, e.g. “lab-rack-3, shelf B”."
            onChange={(e) => setLabel(e.target.value)}
          />
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </Dialog>

      {/* Reveal-once dialog. onClose fires for every dismissal path (Escape,
          backdrop click, the button below) — that's fine, because the
          security property here is "never shown again after this instant",
          not "must be dismissed a specific way". Same as any PAT-reveal UI. */}
      <Dialog
        open={issuedToken !== null}
        onClose={() => setIssuedToken(null)}
        title="Credential issued"
        actions={
          <Button size="sm" variant="primary" onClick={() => setIssuedToken(null)}>
            Done — I&rsquo;ve saved it
          </Button>
        }
      >
        {issuedToken ? (
          <div className={styles.reveal}>
            <p className={styles.warning} role="alert">
              This is the only time this token will be shown. Copy it now — it cannot be retrieved again, only
              revoked and re-issued.
            </p>
            <div className={styles.tokenRow}>
              <Mono>
                <span className={styles.tokenValue}>{issuedToken.rawToken}</span>
              </Mono>
              <Button size="sm" variant="secondary" onClick={onCopyToken}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className={styles.hint}>
              Set this as <Mono>AGENT_CREDENTIAL_TOKEN</Mono> on the agent for <strong>{issuedToken.machineId}</strong>.
            </p>
          </div>
        ) : null}
      </Dialog>

      {/* Revoke confirm — consequential and not reversible by re-clicking,
          same reasoning as force-unlocking someone else's device. */}
      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke this credential?"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirmRevoke}>
              Revoke
            </Button>
          </>
        }
      >
        {revokeTarget ? (
          <>
            The agent for <strong>{revokeTarget.machineId}</strong>
            {revokeTarget.label ? ` (${revokeTarget.label})` : ''} will be rejected on its very next request. It
            will need a new credential to reconnect.
          </>
        ) : null}
      </Dialog>
    </Page>
  );
}
