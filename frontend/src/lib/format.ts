/** Shared value formatting so numbers and dates read the same everywhere. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return '—';
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago" — platform Intl, no date library needed. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
  ];
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const u of units) if (abs >= u[1]) chosen = u;
  return rtf.format(Math.round(diffMs / chosen[1]), chosen[0]);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Short id for display: 6a898e44…fb1 */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}
