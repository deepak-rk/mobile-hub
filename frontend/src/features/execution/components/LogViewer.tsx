import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { icons, iconSize } from '@/lib/icons';
import type { StreamState } from '../api/useRunStream';
import styles from './LogViewer.module.css';

const STREAM_LABEL: Record<StreamState, { text: string; tone: string }> = {
  idle: { text: 'Not streaming', tone: 'var(--text-tertiary)' },
  connecting: { text: 'Connecting…', tone: 'var(--status-running)' },
  live: { text: 'Live', tone: 'var(--status-idle)' },
  reconnecting: { text: 'Reconnecting…', tone: 'var(--status-smoke)' },
  closed: { text: 'Disconnected — retrying', tone: 'var(--status-smoke)' },
  unauthenticated: { text: 'Sign in to stream logs', tone: 'var(--text-tertiary)' },
};

/**
 * Connection state is always visible (guidelines §10: the stream banner is
 * non-negotiable) — a dropped socket must never look like a quiet run.
 */
export function StreamStatusBanner({ state }: { state: StreamState }) {
  const { text, tone } = STREAM_LABEL[state];
  const live = state === 'live';
  return (
    <span className={styles.banner} style={{ color: tone }} aria-live="polite">
      <span className={`${styles.dot} ${live ? styles.pulse : ''}`} style={{ background: tone }} aria-hidden="true" />
      {text}
    </span>
  );
}

export function LogViewer({ lines, streamState }: { lines: string[]; streamState: StreamState }) {
  const boxRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);

  // Only auto-scroll while the reader is already at the bottom; scrolling up
  // to read something must not be yanked away by the next line.
  useLayoutEffect(() => {
    if (!follow) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>Output</span>
        <StreamStatusBanner state={streamState} />
      </div>

      <div className={styles.body}>
        <pre className={styles.log} ref={boxRef} tabIndex={0} aria-label="Run output">
          {lines.length === 0
            ? streamState === 'unauthenticated'
              ? 'Sign in to see live output for this run.'
              : 'Waiting for output…'
            : lines.join('')}
        </pre>

        {!follow && lines.length > 0 ? (
          <div className={styles.jump}>
            <Button size="sm" onClick={() => setFollow(true)}>
              <icons.downloading size={iconSize.control} aria-hidden="true" />
              Jump to latest
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
