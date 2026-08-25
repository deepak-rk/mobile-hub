import { getStatusMeta } from '@/lib/status';
import { iconSize } from '@/lib/icons';
import styles from './StatusBadge.module.css';

interface StatusBadgeProps {
  status: string;
  /** Extra context rendered after the label, e.g. the user holding a lock. */
  detail?: string;
  /** Drop the pill chrome for dense table cells. */
  bare?: boolean;
}

/**
 * The only place a status is turned into pixels. Always renders color + icon +
 * text together (guidelines §7) so status is never conveyed by color alone.
 */
export function StatusBadge({ status, detail, bare }: StatusBadgeProps) {
  const meta = getStatusMeta(status);
  const Icon = meta.icon;

  return (
    <span
      className={[styles.badge, meta.active ? styles.active : '', bare ? styles.bare : '']
        .filter(Boolean)
        .join(' ')}
      style={{ ['--status-color' as string]: `var(${meta.token})` }}
    >
      <Icon className={styles.icon} size={iconSize.dense} aria-hidden="true" />
      <span className={styles.label}>
        {meta.label}
        {detail ? ` · ${detail}` : ''}
      </span>
    </span>
  );
}
