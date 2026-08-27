import { parse as parseYaml } from 'yaml';
import { partialConfigSchema, EffectiveConfig, PLATFORM_DEFAULTS } from './org-config.schema';
import dynamicImport from '../common/dynamic-import';
import type * as LayeredConfigTs from 'layered-config-ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: EffectiveConfig;
  }
}

/**
 * Loads, validates, and merges org + project config from disk via
 * layered-config-ts (dynamic import: that package is ESM-only, this backend
 * is still CommonJS — see docs/LESSONS.md). Missing files are treated as
 * empty overrides (PLATFORM_DEFAULTS apply), matching root CLAUDE.md §11:
 * the platform is configurable, not prescriptive — an org/project with no
 * yaml files still gets a fully-formed EffectiveConfig. Throws on invalid
 * YAML or a schema violation (e.g. a typo'd key).
 */
export async function loadEffectiveConfig(orgPath: string, projectPath: string): Promise<EffectiveConfig> {
  const { loadLayeredConfig } = await dynamicImport<typeof LayeredConfigTs>('layered-config-ts');
  return loadLayeredConfig({
    schema: partialConfigSchema,
    defaults: PLATFORM_DEFAULTS,
    layers: [orgPath, projectPath],
    parse: parseYaml,
  });
}
