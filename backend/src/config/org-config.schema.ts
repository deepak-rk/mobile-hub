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

const buildConfigSchema = z
  .object({
    provider: buildProviderNameSchema.optional(),
    url: z.object({}).strict().optional(),
    nexus: z.object({ baseUrl: z.string().optional(), repository: z.string().optional() }).strict().optional(),
    s3: z.object({ bucket: z.string().optional(), region: z.string().optional() }).strict().optional(),
    webhook: z.object({ endpoint: z.string().optional() }).strict().optional(),
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
  };
  automation: { framework: string; configPath: string; envFile: string; testDir: string };
}

export const PLATFORM_DEFAULTS: EffectiveConfig = {
  features: { builds: true, execution: true, analytics: true, streaming: true },
  build: { provider: 'url', url: {}, nexus: {}, s3: {}, webhook: {} },
  automation: { framework: 'appium', configPath: 'wdio.conf.js', envFile: '.env', testDir: 'test' },
};
