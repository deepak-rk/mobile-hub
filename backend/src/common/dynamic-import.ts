/**
 * A real dynamic `import()` that survives `tsc`'s CommonJS module transform.
 *
 * `tsc`, compiling to CommonJS (this backend's target), rewrites a literal
 * `await import(x)` into `require(x)` wrapped in a resolved promise —
 * confirmed by inspecting the compiled output. That defeats the entire point
 * when `x` is an ESM-only package with no `require` export condition: Node's
 * CommonJS loader throws `ERR_PACKAGE_PATH_NOT_EXPORTED` ("No 'exports' main
 * defined"). This only breaks the *compiled* output (`node dist/...`, what
 * Docker and production run) — `tsx watch` uses its own loader and never
 * downlevels it, so every dev-mode verification of the affected packages
 * passed while the real production path was silently broken. Only surfaced
 * once `docker compose up` was actually run.
 *
 * `new Function` hides the `import()` call from `tsc`'s static rewrite —
 * it's inside a string body, parsed and evaluated by V8 at runtime, never
 * seen by the TypeScript compiler — so Node's real ESM loader handles it.
 * This is the standard workaround for this exact, well-known TS/Node gap.
 *
 * Use this for every ESM-only dependency imported from CommonJS code here,
 * not the `await import(...)` syntax directly — the syntax alone is not
 * enough to guarantee a real dynamic import once compiled.
 */
// Deliberate: this is the point of the file (see the doc comment above),
// not a real eval risk — `specifier` is always a fixed literal at every
// call site in this codebase, never user input.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = unknown>(
  specifier: string,
) => Promise<T>;

export default dynamicImport;
