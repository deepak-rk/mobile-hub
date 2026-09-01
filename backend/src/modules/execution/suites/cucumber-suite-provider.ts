import * as fs from 'fs';
import * as path from 'path';
import { AutomationConfig } from '../../../config/org-config.schema';
import { DiscoveredSuite, SuiteProvider, parseFeatureFile } from './suite-provider';

/** Guards against walking a pathological tree; a real suite dir is nowhere near this. */
const MAX_FEATURE_FILES = 500;

/**
 * Discovers runnable suites in a Cucumber/WebdriverIO repo by reading its
 * `.feature` files under the configured `testDir`.
 *
 * `testDir` is one of the config keys that was declared and never read; this is
 * what reads it. Files are parsed as text, never imported — see SuiteProvider
 * for why executing a cloned repo to enumerate it is not acceptable.
 *
 * Both tags and individual feature files are offered because teams address
 * suites both ways: `@smoke` spans files, while a single feature is what you
 * pick when debugging one area.
 */
export class CucumberSuiteProvider implements SuiteProvider {
  readonly framework = 'appium';

  async discover(repoDir: string, automation: AutomationConfig): Promise<DiscoveredSuite[]> {
    const testDir = path.resolve(repoDir, automation.testDir);
    // A configured testDir that isn't there is a real misconfiguration, but an
    // empty list lets the caller say "none found" rather than erroring the
    // whole page — the operator can still type a suite by hand.
    if (!fs.existsSync(testDir)) return [];

    const files = collectFeatureFiles(testDir);
    const tagCounts = new Map<string, number>();
    const features: DiscoveredSuite[] = [];

    for (const absolute of files) {
      const relative = path.relative(repoDir, absolute).split(path.sep).join('/');
      let parsed;
      try {
        parsed = parseFeatureFile(await fs.promises.readFile(absolute, 'utf8'));
      } catch {
        // An unreadable file shouldn't hide every other suite in the repo.
        continue;
      }

      features.push({
        id: relative,
        name: parsed.title ?? path.basename(relative),
        kind: 'feature',
        file: relative,
      });
      for (const tag of parsed.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const tags: DiscoveredSuite[] = [...tagCounts.entries()]
      .map(([tag, fileCount]) => ({ id: tag, name: tag, kind: 'tag' as const, fileCount }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Tags first: they are the coarse "run the smoke set" choice most runs
    // want, while individual features are the narrower follow-up.
    return [...tags, ...features.sort((a, b) => a.name.localeCompare(b.name))];
  }
}

function collectFeatureFiles(dir: string): string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    if (found.length >= MAX_FEATURE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_FEATURE_FILES) return;
      const full = path.join(current, entry.name);
      // node_modules under a test dir is someone else's fixtures, not this
      // repo's suites, and walking it is slow enough to matter.
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.feature')) {
        found.push(full);
      }
    }
  };

  walk(dir);
  return found;
}
