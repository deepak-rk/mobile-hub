import type { StatusKind } from '@/lib/status';
import type { BoardStatus } from '../api/execution.api';

/** A scenario's `ready` is "not run", so it gets its own badge, not the green of a ready build. */
export function boardBadge(status: BoardStatus): StatusKind {
  return status === 'ready' ? 'not-run' : status;
}
