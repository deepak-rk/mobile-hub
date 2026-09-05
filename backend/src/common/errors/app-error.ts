/**
 * Typed domain errors, per backend/CLAUDE.md's architecture rule: "use typed
 * domain errors ... with a stable code and safe message, mapped to HTTP
 * status centrally — not ad-hoc `throw new Error(string)` scattered through
 * services." Before this, every route hand-rolled its own
 * `catch (err) { if (err instanceof X) return reply.status(N).send(...) }`
 * chain, and a handful of module-specific error classes (`DeviceLockedError`,
 * `BuildNotReadyError`, ...) each extended plain `Error` with no shared base
 * — see docs/TODO.md's "no typed domain error classes" row.
 *
 * `AppError` carries everything a route needs to respond correctly baked in
 * at the throw site: `statusCode` and `code` are fixed per subclass (with an
 * optional override for the handful of call sites that need a more specific
 * code at the same status, e.g. `DEVICE_LOCKED` is a 409 `ConflictError`).
 * `app.setErrorHandler` in `app.ts` is the one place that maps an `AppError`
 * to a response — a route that throws one no longer needs its own catch
 * block at all.
 *
 * `message` is asserted safe to return to a caller by construction: every
 * subclass is for an expected, named failure mode (not found, conflict,
 * validation, forbidden), never a caught exception whose message might carry
 * internal detail — the global handler treats anything that isn't an
 * `AppError` as opaque and returns a generic 500, never the raw message.
 */
export abstract class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message, 400, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, 409, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}
