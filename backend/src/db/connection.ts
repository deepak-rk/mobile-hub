import mongoose from 'mongoose';
import { env } from '../config/env';

export async function connectDB(): Promise<void> {
  // The database name comes from MONGODB_URI's path segment and nothing else.
  // Never pass a hardcoded `dbName` here: it silently overrides the URI, which
  // makes every deployment/test that points at a different database (e.g. an
  // E2E run against `.../mobilehub_e2e`) quietly read and write the wrong one.
  await mongoose.connect(env.MONGODB_URI);
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
