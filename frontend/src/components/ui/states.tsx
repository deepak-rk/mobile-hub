import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { icons, iconSize } from '@/lib/icons';
import { Button } from './Button';
import styles from './states.module.css';

/** A single shimmering placeholder block. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={[styles.skeleton, className].filter(Boolean).join(' ')} style={style} aria-hidden="true" />;
}

/** Card-shaped skeletons for list loading — never a full-screen spinner (guidelines §14). */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={styles.skeletonCard} />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon: Icon = icons.dot, title, body, action }: EmptyStateProps) {
  return (
    <div className={styles.state}>
      <Icon className={styles.stateIcon} size={iconSize.empty} aria-hidden="true" />
      <div className={styles.stateTitle}>{title}</div>
      {body ? <div className={styles.stateBody}>{body}</div> : null}
      {action ? (
        <div className={styles.stateAction}>
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The `{ code, message }` shape the API client normalizes every error into. */
export interface ApiError {
  code?: string;
  message?: string;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const err = (error ?? {}) as ApiError;
  return (
    <div className={styles.state} role="alert">
      <icons.corrupt className={styles.errorIcon} size={iconSize.empty} aria-hidden="true" />
      <div className={styles.stateTitle}>Something went wrong</div>
      <div className={styles.stateBody}>{err.message ?? 'The request failed. Please try again.'}</div>
      {err.code ? <div className={styles.stateCode}>{err.code}</div> : null}
      {onRetry ? (
        <div className={styles.stateAction}>
          <Button size="sm" onClick={onRetry}>
            <icons.retry size={iconSize.control} aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders whichever of loading / error / empty applies, or the children when
 * there's real data. Keeps every list page handling all four states without
 * each one reinventing the branching.
 */
export function QueryBoundary({
  isPending,
  error,
  isEmpty,
  empty,
  onRetry,
  skeletonCount,
  children,
}: {
  isPending: boolean;
  error: unknown;
  isEmpty?: boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  skeletonCount?: number;
  children: ReactNode;
}) {
  if (isPending) return <SkeletonList count={skeletonCount} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}
