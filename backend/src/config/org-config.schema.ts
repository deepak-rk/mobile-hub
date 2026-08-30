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
  devices: { lockTtlMinutes: number | null };
  automation: AutomationConfig;
  /** Declared projects, keyed by id. Empty when an org hasn't declared any. */
  projects: Record<string, ProjectConfig>;
}

export interface AutomationConfig {
  framework: string;
  configPath: string;
  envFile: string;
  testDir: string;
  repoUrl: string | null;
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
  devices: { lockTtlMinutes: 45 },
  automation: { framework: 'appium', configPath: 'wdio.conf.js', envFile: '.env', testDir: 'test', repoUrl: null },
  // No projects until an org declares them. The trigger form falls back to
  // free text in that case rather than offering an empty dropdown.
  projects: {},
};
