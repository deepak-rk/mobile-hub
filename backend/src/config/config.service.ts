import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';
import {
  partialConfigSchema,
  EffectiveConfig,
  PLATFORM_DEFAULTS,
  RawProjectConfig,
  resolveProjects,
  normalizeAutomation,
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
export interface LoadConfigOptions {
  /** HUB_APPIUM_HOST: where the hub's own Appium servers listen. Wins over the deprecated YAML `appium.host`. */
  hubAppiumHost?: string;
  /** Receives deprecation warnings (a key in the file it no longer belongs in). */
  warn?: (message: string) => void;
}

/** The top level of one YAML file as written, for "which file declared this" checks the merged result cannot answer. */
function readRaw(filePath: string): Record<string, unknown> {
  try {
    const doc: unknown = parseYaml(fs.readFileSync(filePath, 'utf8'));
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  } catch {
    return {}; // missing file; an unparseable one is reported by the real load below
  }
}

/**
 * The config split (plan §3.4): the org file holds platform concerns, the
 * project file holds the app (`projects:`, its build source, automation).
 * Keys in the wrong file still load for now, with a warning, so an existing
 * deployment keeps working while it moves them.
 */
function splitWarnings(orgPath: string, projectPath: string, hubAppiumHost: string | undefined): string[] {
  const org = readRaw(orgPath);
  const project = readRaw(projectPath);
  const warnings: string[] = [];
  if (org.projects !== undefined) {
    warnings.push(
      `'projects:' in ${orgPath} is deprecated: move it to ${projectPath}. It still loads in this release.`,
    );
  }
  const yamlHost = [org, project].some(
    (layer) => typeof layer.appium === 'object' && layer.appium !== null && 'host' in layer.appium,
  );
  if (yamlHost) {
    warnings.push(
      hubAppiumHost
        ? "'appium.host' in YAML is ignored because HUB_APPIUM_HOST is set; remove it from the YAML."
        : "'appium.host' in YAML is deprecated: set HUB_APPIUM_HOST instead. It still applies in this release.",
    );
  }
  return warnings;
}

export async function loadEffectiveConfig(
  orgPath: string,
  projectPath: string,
  options: LoadConfigOptions = {},
): Promise<EffectiveConfig> {
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
  const automation = normalizeAutomation(merged.automation);
  for (const warning of splitWarnings(orgPath, projectPath, options.hubAppiumHost)) options.warn?.(warning);
  const appium = options.hubAppiumHost ? { ...merged.appium, host: options.hubAppiumHost } : merged.appium;
  return { ...merged, appium, automation, projects: resolveProjects(rawProjects, automation) };
}
