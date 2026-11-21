import type { ReactNode } from 'react';
import { Card, CardBody, EmptyState, Page } from 'react-design-kit';
import { icons } from '@/lib/icons';
import { useFeatureDisabled, type Feature } from '../api/features.api';

/**
 * Wraps a module's route so a direct visit while the module is switched off
 * says so, instead of rendering a page whose every request fails with
 * FEATURE_DISABLED. Renders the children as normal while the toggles are
 * unknown (loading or failed), see useFeatureDisabled.
 */
export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const disabled = useFeatureDisabled(feature);
  if (!disabled) return <>{children}</>;

  return (
    <Page>
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.locked}
            title="This module is disabled for your organisation"
            body={`The ${feature} module is switched off in the organisation config (features.${feature}). An admin can enable it there.`}
          />
        </CardBody>
      </Card>
    </Page>
  );
}
