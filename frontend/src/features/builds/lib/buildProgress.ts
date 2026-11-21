import { formatBytes } from 'ts-format-utils';
import type { Build } from '../types';

/**
 * Builds move downloading → validating → ready|corrupt|purged. While
 * downloading, the backend persists `downloadedBytes` (and `sizeBytes` once
 * the source reports it) about once a second, so the bar is a real byte
 * ratio. With no known total there is no honest percentage, so it shows the
 * bytes received as text and no bar — never a made-up fill.
 */
export function buildProgress(
  build: Pick<Build, 'status' | 'sizeBytes' | 'downloadedBytes'>,
): { value: number | null; complete: boolean; label: string } | null {
  if (build.status === 'validating') return { value: 100, complete: false, label: 'Verifying checksum…' };
  if (build.status !== 'downloading') return null;
  const done = build.downloadedBytes;
  if (build.sizeBytes && build.sizeBytes > 0 && done !== undefined) {
    const value = Math.min(100, Math.round((done / build.sizeBytes) * 100));
    return {
      value,
      complete: false,
      label: `Downloading · ${formatBytes(done)} of ${formatBytes(build.sizeBytes)} (${value}%)`,
    };
  }
  return { value: null, complete: false, label: done ? `Downloading · ${formatBytes(done)} so far…` : 'Downloading…' };
}
