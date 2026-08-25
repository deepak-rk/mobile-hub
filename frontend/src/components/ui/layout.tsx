import { HTMLAttributes, ReactNode } from 'react';
import styles from './layout.module.css';

export function Page({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.titleGroup}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive, className, children, ...rest }: CardProps) {
  return (
    <div
      className={[styles.card, interactive ? styles.cardInteractive : '', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardBody({ children }: { children: ReactNode }) {
  return <div className={styles.cardBody}>{children}</div>;
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export function List({ children }: { children: ReactNode }) {
  return <div className={styles.list}>{children}</div>;
}

export function Meta({ children }: { children: ReactNode }) {
  return <div className={styles.meta}>{children}</div>;
}

export function MetaSep() {
  return (
    <span className={styles.metaSep} aria-hidden="true">
      ·
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>;
}

/** Counts row under a list, e.g. "12 total · 8 online · 3 in use". */
export function Summary({ items }: { items: { label: string; value: number | string }[] }) {
  return (
    <div className={styles.summary}>
      {items.map((i) => (
        <span key={i.label}>
          <span className={styles.summaryValue}>{i.value}</span> {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * 4px progress bar (guidelines §8). Fill turns green once complete so the
 * "validated" moment is visible without reading the label.
 */
export function ProgressBar({
  value,
  label,
  complete,
  tone,
}: {
  value: number;
  label?: string;
  complete?: boolean;
  /** Overrides the fill color — use for quality metrics (pass rate), where
      accent-vs-green would wrongly read as "how far along" rather than "how good". */
  tone?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div
          className={[styles.progressFill, complete && !tone ? styles.progressComplete : ''].filter(Boolean).join(' ')}
          style={{ width: `${pct}%`, ...(tone ? { background: tone } : {}) }}
        />
      </div>
      {label ? <div className={styles.progressLabel}>{label}</div> : null}
    </div>
  );
}

export function DescriptionList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className={styles.dl}>
      {items.map((i) => (
        <div key={i.term} style={{ display: 'contents' }}>
          <dt className={styles.dt}>{i.term}</dt>
          <dd className={styles.dd}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
