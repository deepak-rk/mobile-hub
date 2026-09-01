import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLATFORM_DEFAULTS } from '../../../config/org-config.schema';
import { parseFeatureFile } from './suite-provider';
import { CucumberSuiteProvider } from './cucumber-suite-provider';

/**
 * Suite discovery replaced a free-text field that selected nothing — a typo
 * previously cost a clone, an install and a runner start before failing. These
 * pin the parsing, which is the part that actually breaks: Gherkin puts tags in
 * several places and `@` also appears in ordinary step text.
 */
describe('parseFeatureFile', () => {
  it('reads the feature title and tags from every level', () => {
    const { title, tags } = parseFeatureFile(
      ['@smoke @regression', 'Feature: Login flow', '', '  @slow', '  Scenario: bad password', '    Given I am on login'].join(
        '\n',
      ),
    );
    expect(title).toBe('Login flow');
    expect(tags.sort()).toEqual(['@regression', '@slow', '@smoke']);
  });

  it('does not mistake an @ inside step text for a tag', () => {
    // The exact false positive a naive /@\w+/ scan produces.
    const { tags } = parseFeatureFile(
      ['@smoke', 'Feature: Support', '  Scenario: contact', '    Then I email support@example.com'].join('\n'),
    );
    expect(tags).toEqual(['@smoke']);
  });

  it('deduplicates a tag repeated across scenarios', () => {
    const { tags } = parseFeatureFile(
      ['Feature: F', '  @smoke', '  Scenario: a', '  @smoke', '  Scenario: b'].join('\n'),
    );
    expect(tags).toEqual(['@smoke']);
  });

  it('survives a file with no feature line and no tags', () => {
    expect(parseFeatureFile('# just a comment\n')).toEqual({ title: null, tags: [] });
  });
});

describe('CucumberSuiteProvider', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-suites-'));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function writeFeature(relative: string, contents: string) {
    const full = path.join(repoDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  it('offers tags and feature files, tags first', async () => {
    writeFeature('test/features/login.feature', '@smoke\nFeature: Login flow\n');
    writeFeature('test/features/deep/cart.feature', '@smoke @slow\nFeature: Cart\n');

    const suites = await new CucumberSuiteProvider().discover(repoDir, PLATFORM_DEFAULTS.automation);

    const tags = suites.filter((s) => s.kind === 'tag');
    const features = suites.filter((s) => s.kind === 'feature');
    // Tags are the coarse "run the smoke set" choice most runs want.
    expect(suites.slice(0, tags.length).every((s) => s.kind === 'tag')).toBe(true);
    expect(tags.find((t) => t.id === '@smoke')?.fileCount).toBe(2);
    expect(tags.find((t) => t.id === '@slow')?.fileCount).toBe(1);
    // Paths are POSIX-style regardless of host, since they are passed to a
    // runner that expects them that way.
    expect(features.map((f) => f.id).sort()).toEqual([
      'test/features/deep/cart.feature',
      'test/features/login.feature',
    ]);
    // The feature's own title reads better in a dropdown than its filename.
    expect(features.find((f) => f.id === 'test/features/login.feature')?.name).toBe('Login flow');
  });

  it('ignores node_modules under the test directory', async () => {
    writeFeature('test/features/real.feature', 'Feature: Real\n');
    writeFeature('test/node_modules/some-pkg/fixture.feature', '@vendor\nFeature: Not ours\n');

    const suites = await new CucumberSuiteProvider().discover(repoDir, PLATFORM_DEFAULTS.automation);

    expect(suites.map((s) => s.id)).not.toContain('@vendor');
    expect(suites.filter((s) => s.kind === 'feature')).toHaveLength(1);
  });

  it('returns nothing rather than throwing when testDir does not exist', async () => {
    // A misconfigured testDir shouldn't error the whole form — the operator
    // can still type a suite by hand.
    expect(await new CucumberSuiteProvider().discover(repoDir, PLATFORM_DEFAULTS.automation)).toEqual([]);
  });
});
