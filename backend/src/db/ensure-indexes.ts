import mongoose from 'mongoose';

export class IndexBuildError extends Error {
  constructor(
    public readonly failures: { model: string; reason: string }[],
    message: string,
  ) {
    super(message);
    this.name = 'IndexBuildError';
  }
}

/**
 * Builds every registered model's indexes and *reports* any failure.
 *
 * Mongoose builds indexes in the background and swallows the error when a
 * build fails, so an app can run indefinitely without a uniqueness guarantee
 * it believes it has. That is not academic here: `auth` maps Mongo's E11000
 * to a 409 on duplicate registration, so a missing `users.email` unique index
 * silently turns duplicate signups into 201s and creates real duplicate
 * accounts — with nothing in the logs. (This actually happened; see
 * docs/LESSONS.md.)
 *
 * Called at startup, before the server accepts traffic, so the failure is
 * loud and immediate rather than a silent correctness hole.
 */
export async function ensureIndexes(): Promise<void> {
  const failures: { model: string; reason: string }[] = [];

  await Promise.all(
    Object.values(mongoose.models).map(async (model) => {
      try {
        // `createIndexes` rejects on failure, unlike the background build
        // Mongoose performs automatically.
        await model.createIndexes();
      } catch (err) {
        failures.push({
          model: model.modelName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  if (failures.length > 0) {
    const detail = failures.map((f) => `  - ${f.model}: ${f.reason}`).join('\n');
    throw new IndexBuildError(
      failures,
      `Failed to build indexes for ${failures.length} model(s):\n${detail}\n` +
        `The most common cause is pre-existing documents that violate a unique index. ` +
        `Resolve the duplicates, then restart — continuing would run without the uniqueness ` +
        `guarantees the application relies on (e.g. duplicate account registration).`,
    );
  }
}
