/**
 * Content-Security-Policy for everything the backend serves. Three policies,
 * because the backend serves three very different kinds of response:
 *
 * - **API (the default, set globally via helmet).** JSON and the odd log
 *   file — nothing a browser should ever execute, style, frame or submit a
 *   form from. `default-src 'none'` means a response that is somehow rendered
 *   as HTML (a reflected value, a mis-typed content type) can't load or run
 *   anything.
 *
 * - **Swagger UI at /docs.** Hub-controlled, same-origin, loads only its own
 *   bundled scripts/styles from /docs/static and fetches /docs/json. No
 *   inline scripts (the initializer is a separate file), so `script-src
 *   'self'` is enough. Inline styles are allowed because the UI's components
 *   set some via style attributes; style injection is low-risk compared with
 *   script.
 *
 * - **Allure reports at /api/execution/:id/report/*.** Untrusted HTML a test
 *   runner produced — the hub never inspects it. Single-file reports inline
 *   every script/style and embed assets as data: URIs, so the script/style
 *   allowances have to be broad. The isolation comes from `sandbox
 *   allow-scripts` *without* `allow-same-origin`: the browser gives the
 *   document an opaque origin, so report scripts run but cannot read the
 *   hub's cookies or localStorage (where a same-origin deployment would keep
 *   the auth token), and cannot make credentialed same-origin requests to the
 *   API. `allow-popups` lets report links open in a new tab.
 *
 * Directive names are helmet's camelCase form; `useDefaults: false` at the
 * call sites so helmet's own defaults are not merged in underneath these.
 */
type Directives = Record<string, string[]>;

export const API_CSP_DIRECTIVES: Directives = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
};

export const DOCS_CSP_DIRECTIVES: Directives = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
};

export const REPORT_CSP_DIRECTIVES: Directives = {
  sandbox: ['allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox'],
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:'],
  styleSrc: ["'self'", "'unsafe-inline'", 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  mediaSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", 'data:', 'blob:'],
  baseUri: ["'self'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
};

/** Serialises directives to a header value, for plugins that take a raw string (swagger-ui's staticCSP). */
export function serializeCsp(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} ${values.join(' ')}`)
    .join('; ');
}
