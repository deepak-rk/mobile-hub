import { defaultFormatError, type PresentedError } from 'react-design-kit';

/**
 * How an `ApiError` (see `api.ts`) reads on an error state. "Network error"
 * told people nothing: it means the hub did not answer at all, usually because
 * it is restarting, so it says that instead.
 */
export function formatApiError(error: unknown): PresentedError {
  if (isUnreachable(error)) {
    return {
      title: "Can't reach the hub",
      message: "The hub isn't answering. It may be restarting; this page tries again every few seconds.",
    };
  }
  return defaultFormatError(error);
}

export function isUnreachable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'NETWORK_ERROR');
}

/** While a query is failing, poll it this often so the page recovers by itself once the hub is back. */
export const RETRY_WHILE_FAILING_MS = 5_000;
