/**
 * Geometric hexagon mark with a device outline inside (guidelines §2).
 * `currentColor` throughout so it inherits accent or plain white without
 * needing colored variants — and never a gradient.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.2 20.6 7v10L12 21.8 3.4 17V7z" />
      <rect x="9.4" y="8.1" width="5.2" height="7.8" rx="1.1" strokeWidth={1.5} />
    </svg>
  );
}

export function BrandLogo({ showWordmark = true }: { showWordmark?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
        <BrandMark />
      </span>
      {showWordmark ? (
        <span
          style={{
            fontWeight: 560,
            fontSize: 'var(--text-md)',
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
          }}
        >
          Mobile Hub
        </span>
      ) : null}
    </span>
  );
}
