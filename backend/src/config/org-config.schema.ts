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
  })
  .strict();

export const partialConfigSchema = z
  .object({
    features: featureTogglesSchema.optional(),
    build: buildConfigSchema.optional(),
    devices: deviceConfigSchema.optional(),
    automation: automationConfigSchema.optional(),
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
  automation: { framework: string; configPath: string; envFile: string; testDir: string };
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
  automation: { framework: 'appium', configPath: 'wdio.conf.js', envFile: '.env', testDir: 'test' },
};
