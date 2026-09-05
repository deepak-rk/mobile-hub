import { describe, it, expect } from 'vitest';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './app-error';

describe('AppError subclasses', () => {
  it('carry the right default status/code and are all instanceof AppError', () => {
    const cases: [AppError, number, string][] = [
      [new ValidationError('bad input'), 400, 'VALIDATION_ERROR'],
      [new NotFoundError('missing'), 404, 'NOT_FOUND'],
      [new ConflictError('conflict'), 409, 'CONFLICT'],
      [new ForbiddenError('nope'), 403, 'FORBIDDEN'],
    ];
    for (const [err, statusCode, code] of cases) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.statusCode).toBe(statusCode);
      expect(err.code).toBe(code);
    }
  });

  it('accepts a code override while keeping the fixed status for its class', () => {
    // The whole reason for the override: several module-specific errors (e.g.
    // execution.service.ts's DeviceLockedError) need a more specific code at
    // the same status their base class already fixes.
    const err = new ConflictError('device is locked', 'DEVICE_LOCKED');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('DEVICE_LOCKED');
  });

  it('sets name to the concrete subclass, not the abstract base', () => {
    // Matters for anything that logs or asserts on `.name` (e.g. a debugger,
    // or `.rejects.toThrow(SomeSubclass)` in a service test) — a plain
    // `this.name = 'AppError'` in the base constructor would have hidden which
    // concrete error was actually thrown.
    expect(new NotFoundError('x').name).toBe('NotFoundError');
    expect(new ValidationError('x').name).toBe('ValidationError');
  });

  it('preserves the message passed to it verbatim', () => {
    expect(new ConflictError('Device d1 is already locked').message).toBe('Device d1 is already locked');
  });
});
