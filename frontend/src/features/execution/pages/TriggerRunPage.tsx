import { Link } from 'react-router-dom';
import { Card, CardBody, Page, PageHeader } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/states';
import { icons } from '@/lib/icons';

/**
 * Triggering a run is an authenticated, role-gated action (operator/admin).
 * There's no sign-in screen yet, so a form here could only ever fail with a
 * 401 — an honest placeholder beats a broken form (guidelines §14:
 * unauthorized → hide actions by role).
 */
export function TriggerRunPage() {
  return (
    <Page>
      <PageHeader
        title="Trigger a run"
        subtitle="Dispatch a test suite to an available device."
        actions={
          <Link to="/execution">
            <Button size="sm" variant="ghost">
              Back to runs
            </Button>
          </Link>
        }
      />
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.locked}
            title="Sign-in required"
            body="Triggering a run needs an operator or admin session. The authentication flow is not built yet — once it is, this page becomes the trigger form (project, branch, suite, target device, and the commands to run)."
          />
        </CardBody>
      </Card>
    </Page>
  );
}
