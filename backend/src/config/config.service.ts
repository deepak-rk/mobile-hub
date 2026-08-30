import { parse as parseYaml } from 'yaml';
import {
  partialConfigSchema,
  EffectiveConfig,
  PLATFORM_DEFAULTS,
  RawProjectConfig,
  resolveProjects,
} from './org-config.schema';
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
  const merged = loadLayeredConfig({
    schema: partialConfigSchema,
    defaults: PLATFORM_DEFAULTS,
    layers: [orgPath, projectPath],
    parse: parseYaml,
  });

  // Each project inherits the org's automation block and overrides only what
  // it declares. Done after the layered merge, not inside it: that merge is
  // generic over the document, while this is mobile-hub's own rule about one
  // block inheriting another.
  // The merge is typed against EffectiveConfig, but until this line `projects`
  // still holds the raw YAML shape (optional fields, no inherited automation) —
  // the two only coincide after resolving, which is what this does.
  const rawProjects = merged.projects as unknown as Record<string, RawProjectConfig> | undefined;
  return { ...merged, projects: resolveProjects(rawProjects, merged.automation) };
}
