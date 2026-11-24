/**
 * The MongoDB a test file may use, or undefined (the file's DB tests skip).
 * Each file gets its own database, `<name>_<suffix>`: Vitest runs files in
 * parallel, and each drops its database when done, so a shared one would be
 * dropped under another file mid-run.
 */
export function testMongoUri(suffix: string): string | undefined {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) return undefined;
  const url = new URL(uri);
  const db = url.pathname.replace(/^\//, '') || 'mobilehub_test';
  url.pathname = `/${db}_${suffix}`;
  return url.toString();
}
