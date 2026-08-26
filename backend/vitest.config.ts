import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // config/env.ts fails fast (process.exit(1)) on missing MONGODB_URI /
      // JWT_SECRET, since a misconfigured server should refuse to boot. But
      // that means any test file that transitively imports it - even one
      // that only reads BUILDS_DIR/EXECUTIONS_DIR and never touches Mongo -
      // crashes the whole vitest worker unless these are set. No test here
      // ever connects with this URI: Mongoose calls are stubbed via
      // vi.spyOn, per this repo's existing test convention.
      MONGODB_URI: 'mongodb://localhost:27017/mobilehub_test_unused',
      JWT_SECRET: 'vitest_dummy_secret_not_used_for_anything_real_32ch',
    },
  },
});
