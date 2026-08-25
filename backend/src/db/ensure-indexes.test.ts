import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { ensureIndexes, IndexBuildError } from './ensure-indexes';

/**
 * Mongoose swallows background index-build failures, which once let this app
 * run without the `users.email` unique index — silently accepting duplicate
 * registrations (see docs/LESSONS.md). These tests pin the behaviour that
 * replaced it: a failed build must surface, not disappear.
 */
function stubModels(models: Record<string, { createIndexes: () => Promise<void> }>) {
  vi.spyOn(mongoose, 'models', 'get').mockReturnValue(models as unknown as typeof mongoose.models);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureIndexes', () => {
  it('resolves when every model builds its indexes', async () => {
    stubModels({
      User: { modelName: 'User', createIndexes: () => Promise.resolve() } as never,
      Device: { modelName: 'Device', createIndexes: () => Promise.resolve() } as never,
    });
    await expect(ensureIndexes()).resolves.toBeUndefined();
  });

  it('throws instead of swallowing a failed build, naming the model and reason', async () => {
    stubModels({
      User: {
        modelName: 'User',
        createIndexes: () => Promise.reject(new Error('E11000 duplicate key error')),
      } as never,
      Device: { modelName: 'Device', createIndexes: () => Promise.resolve() } as never,
    });

    await expect(ensureIndexes()).rejects.toThrow(IndexBuildError);
    await expect(ensureIndexes()).rejects.toThrow(/User/);
    await expect(ensureIndexes()).rejects.toThrow(/E11000/);
  });

  it('reports every failing model, not just the first', async () => {
    stubModels({
      User: { modelName: 'User', createIndexes: () => Promise.reject(new Error('boom one')) } as never,
      Device: { modelName: 'Device', createIndexes: () => Promise.reject(new Error('boom two')) } as never,
    });

    try {
      await ensureIndexes();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexBuildError);
      const failures = (err as IndexBuildError).failures;
      expect(failures).toHaveLength(2);
      expect(failures.map((f) => f.model).sort()).toEqual(['Device', 'User']);
    }
  });
});
