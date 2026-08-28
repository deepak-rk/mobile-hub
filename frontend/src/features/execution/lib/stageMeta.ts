import { icons } from '@/lib/icons';
import type { RunStage } from '../types';

/**
 * Shared between `RunDetailPage` (full pipeline view) and `CurrentRunPanel`
 * (the compact live card under the trigger form) so a stage's label/icon/
 * color is defined once.
 */
export const STAGE_LABELS: Record<RunStage['name'], string> = {
  pulling: 'Pull repository',
  restoring_cache: 'Restore cache',
  installing: 'Install dependencies',
  execute: 'Execute suite',
};

export function stageIcon(status: RunStage['status']) {
  if (status === 'done') return icons.passed;
  if (status === 'error') return icons.failed;
  if (status === 'running') return icons.running;
  if (status === 'skipped') return icons.cancelled;
  return icons.dot;
}

export function stageColor(status: RunStage['status']): string {
  if (status === 'done') return 'var(--status-passed)';
  if (status === 'error') return 'var(--status-failed)';
  if (status === 'running') return 'var(--status-running)';
  return 'var(--text-disabled)';
}
