import { z } from 'zod';

/**
 * Schema for the *raw* contents of mobilehub.org.yaml / mobilehub.project.yaml.
 * Every field is optional here — a project file only needs to declare what it
 * overrides, and even an org file may rely on PLATFORM_DEFAULTS for the rest.
 * `.strict()` throughout so a typo'd key (e.g. `buidls`) fails validation
 * instead of being silently ignored.
 */
const featureTogglesSchema = z
  .object({
    builds: z.boolean().optional(),
    execution: z.boolean().optional(),
    analytics: z.boolean().optional(),
    streaming: z.boolean().optional(),
  })
  .strict();

export const buildProviderNameSchema = z.enum(['url', 'nexus', 's3', 'webhook']);
export type BuildProviderName = z.infer<typeof buildProviderNameSchema>;

const buildRetentionConfigSchema = z
  .object({
    // Keeps this many most-recent 'ready' builds per (project, platform);
    // older ones are purged (file deleted, status -> 'purged'). A build
    // referenced by any ExecutionRun is never purged regardless of rank.
    keepPerGroup: z.number().int().positive().optional(),
    // Optional extra gate: only purges a build that is BOTH beyond
    // keepPerGroup AND at least this many days old. null/unset disables the
    // age check, so purging is governed by keepPerGroup alone by default -
    // no build is ever removed purely for being old.
    olderThanDays: z.number().int().positive().optional(),
  })
  .strict();

const buildConfigSchema = z
  .object({
    provider: buildProviderNameSchema.optional(),
    url: z.object({}).strict().optional(),
    nexus: z.object({ baseUrl: z.string().optional(), repository: z.string().optional() }).strict().optional(),
    s3: z.object({ bucket: z.string().optional(), region: z.string().optional() }).strict().optional(),
    webhook: z.object({ endpoint: z.string().optional() }).strict().optional(),
    retention: buildRetentionConfigSchema.optional(),
  })
  .strict();

const deviceConfigSchema = z
  .object({
    // A held lock expires this many minutes after it was last
    // acquired/renewed, and is released automatically — a crashed client
    // (not a crashed host; see hosts.service.ts's markStaleHostsOffline for
    // the offline case) must not hold a device forever. null/unset disables
    // expiry entirely; a lock then only ever ends via explicit unlock or the
    // device going offline, the pre-2026-08-27 behaviour.
    lockTtlMinutes: z.number().int().positive().optional(),
    // Off by default: automatically granting every dangerous/runtime
    // permission an installed Android app declares is a real behavioural
    // change to the app under test (it otherwise runs exactly as if a human
    // tapped through the OS permission prompts), and not every org wants an
    // install to imply that. Android only — see installer.ts.
    grantPermissionsOnInstall: z.boolean().optional(),
  })
  .strict();

/** A command as argv, never a shell string — nothing here is shell-interpreted. */
const commandSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) }).strict();

const appiumConfigSchema = z
  .object({
    // Off by default: starting servers is a real side effect on the host, and
    // an org running its own Appium fleet must not have this fight it.
    enabled: z.boolean().optional(),
    host: z.string().optional(),
    // Ports are assigned from here upward, one per device, and then persisted
    // on the device record. The sibling appium-server-setup repo makes the
    // case well: a port allocated fresh each time can leak or race, while one
    // that is written down cannot. This keeps that property for devices the
    // hub discovers rather than ones a human enumerated.
    basePort: z.number().int().positive().optional(),
    // Off by default: this is a genuinely risky rearchitecture (the hub stops
    // spawning Appium itself for a non-local device and instead waits on an
    // agent to do it — see appium.service.ts#ensureRemoteAppiumServer), and
    // today's hub-local-only behavior must stay the default until this is
    // proven. See docs/reference-review-2026-09-14/01-architecture-findings.md
    // §1.3 for the gap this closes: a device on a remote agent host cannot
    // run tests today, since Appium (and adb beneath it) has no way to reach
    // a device on a different physical machine.
    remoteEnabled: z.boolean().optional(),
  })
  .strict();

const streamingConfigSchema = z
  .object({
    // Off by default, same reasoning as appium.remoteEnabled above: the hub
    // stops spawning adb/xcrun itself for a device and instead waits on the
    // owning agent to capture and relay frames back (see
    // streaming.service.ts's AgentRelayCaptureSource). Today's hub-local-only
    // behavior must stay the default until this is proven. See
    // docs/reference-review-2026-09-14/01-architecture-findings.md §1.3 for
    // the identical gap already fixed for Appium — this is the same fix
    // applied to streaming.
    remoteEnabled: z.boolean().optional(),
  })
  .strict();

const automationConfigSchema = z
  .object({
    framework: z.string().optional(),
    configPath: z.string().optional(),
    envFile: z.string().optional(),
    testDir: z.string().optional(),
    // Unset by default: execution.service.ts's pulling/restoring_cache stages
    // stay the existing honest not-implemented stub until an org opts in by
    // setting this — no behavior change for anyone who hasn't configured it.
    repoUrl: z.string().optional(),
    // Explicit commands, for a project whose framework this platform can't
    // build an invocation for, or one that simply wants something else. When
    // unset they are derived from `framework`/`configPath` — see
    // modules/execution/automation-commands.ts.
    install: commandSchema.optional(),
    run: commandSchema.optional(),
    // Injected into the runner process. Values are treated as secret: they
    // are redacted from run logs, and the child gets an allow-listed
    // environment rather than inheriting the hub's.
    env: z.record(z.string()).optional(),
  })
  .strict();

/**
 * One project the platform knows about, declared in YAML.
 *
 * Everything here is optional and falls back to the top-level `automation`
 * block, so declaring a project costs one line — `myapp: {}` is enough to make
 * it selectable — while a project that genuinely differs (its own repo,
 * framework or layout) overrides only what differs. That inheritance is the
 * point: the platform adapts to an organisation's conventions rather than
 * demanding every project restate them (root CLAUDE.md §11).
 */
const projectConfigSchema = z
  .object({
    displayName: z.string().optional(),
    platform: z.enum(['android', 'ios']).optional(),
    automation: automationConfigSchema.optional(),
  })
  .strict();

export const partialConfigSchema = z
  .object({
    features: featureTogglesSchema.optional(),
    build: buildConfigSchema.optional(),
    devices: deviceConfigSchema.optional(),
    appium: appiumConfigSchema.optional(),
    streaming: streamingConfigSchema.optional(),
    automation: automationConfigSchema.optional(),
    // Keyed by project id — the same string that lands on ExecutionRun.project
    // and Build.project, so config and history line up without a mapping table.
    projects: z.record(projectConfigSchema).optional(),
  })
  .strict();

export type PartialConfig = z.infer<typeof partialConfigSchema>;

export interface EffectiveConfig {
  features: { builds: boolean; execution: boolean; analytics: boolean; streaming: boolean };
  build: {
    provider: BuildProviderName;
    url: Record<string, never>;
    nexus: { baseUrl?: string; repository?: string };
    s3: { bucket?: string; region?: string };
    webhook: { endpoint?: string };
    retention: { keepPerGroup: number; olderThanDays: number | null };
  };
  devices: { lockTtlMinutes: number | null; grantPermissionsOnInstall: boolean };
  appium: { enabled: boolean; host: string; basePort: number; remoteEnabled: boolean };
  streaming: { remoteEnabled: boolean };
  automation: AutomationConfig;
  /** Declared projects, keyed by id. Empty when an org hasn't declared any. */
  projects: Record<string, ProjectConfig>;
}

export interface AutomationCommand {
  command: string;
  args: string[];
}

export interface AutomationConfig {
  framework: string;
  configPath: string;
  envFile: string;
  testDir: string;
  repoUrl: string | null;
  /** Overrides the command derived from `framework`; null means derive it. */
  install: AutomationCommand | null;
  run: AutomationCommand | null;
  /** Injected into the runner; treated as secret (redacted from logs). */
  env: Record<string, string>;
}

export interface ProjectConfig {
  id: string;
  displayName: string;
  platform: 'android' | 'ios' | null;
  /** Fully resolved: the project's own overrides merged over the org defaults. */
  automation: AutomationConfig;
}

/**
 * Expands the raw `projects` block into fully-resolved entries, each carrying
 * its own automation config merged over the org-level defaults.
 *
 * Kept out of the layered-config merge because that merge is generic over the
 * whole document, while this is a domain rule — one block inheriting another —
 * that only mobile-hub knows. Resolving once here means no caller has to
 * remember which layer a value came from.
 */
export type RawProjectConfig = z.infer<typeof projectConfigSchema>;

export function resolveProjects(
  raw: Record<string, RawProjectConfig> | undefined,
  automation: AutomationConfig,
): Record<string, ProjectConfig> {
  const resolved: Record<string, ProjectConfig> = {};
  for (const [id, project] of Object.entries(raw ?? {})) {
    resolved[id] = {
      id,
      // A project that doesn't name itself is shown by its id, which is what
      // an operator typed into the trigger form anyway.
      displayName: project.displayName ?? id,
      platform: project.platform ?? null,
      automation: { ...automation, ...stripUndefined(project.automation) },
    };
  }
  return resolved;
}

/**
 * Drops keys the YAML simply omitted, so they fall through to the org default
 * rather than overwriting it with `undefined` — the difference between "this
 * project doesn't override testDir" and "this project has no testDir".
 */
function stripUndefined<T extends object>(source: T | undefined): Partial<T> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const PLATFORM_DEFAULTS: EffectiveConfig = {
  features: { builds: true, execution: true, analytics: true, streaming: true },
  build: {
    provider: 'url',
    url: {},
    nexus: {},
    s3: {},
    webhook: {},
    retention: { keepPerGroup: 10, olderThanDays: null },
  },
  // 45 min: long enough for someone actively testing on a device, short
  // enough that a crashed/forgotten client doesn't hold it all day.
  devices: { lockTtlMinutes: 45, grantPermissionsOnInstall: false },
  // Off by default: starting a server is a real side effect on the host.
  appium: { enabled: false, host: '127.0.0.1', basePort: 4723, remoteEnabled: false },
  streaming: { remoteEnabled: false },
  automation: {
    framework: 'appium',
    configPath: 'wdio.conf.js',
    envFile: '.env',
    testDir: 'test',
    repoUrl: null,
    // Derived from framework/configPath unless an org declares otherwise.
    install: null,
    run: null,
    env: {},
  },
  // No projects until an org declares them. The trigger form falls back to
  // free text in that case rather than offering an empty dropdown.
  projects: {},
};
