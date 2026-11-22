import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigError } from 'layered-config-ts';
import { loadEffectiveConfig } from './config.service';
import { PLATFORM_DEFAULTS, resolveProjects } from './org-config.schema';

// config.service.ts imports layered-config-ts through common/dynamic-import,
// whose `new Function`-wrapped import() is what makes it survive tsc's
// CommonJS downlevel in the real compiled build (see that file's doc
// comment) — but the same trick throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
// under Vitest, which runs test modules inside a vm sandbox that only wires
// up a dynamic-import callback for code it transforms itself, not for a
// separately-compiled `new Function` body. This mock routes around that by
// delegating to a plain `import()` written directly in this file, which
// Vitest's own transform handles correctly — still a real import of the
// real package, not a stub, so this test still exercises actual
// layered-config-ts behavior end to end.
vi.mock('../common/dynamic-import', () => ({
  default: (specifier: string) => import(specifier),
}));

// Generic merge/parse/validation behavior is covered by layered-config-ts's
// own test suite. These tests only check that this backend's schema,
// defaults, and YAML wiring are plugged in correctly.

const tmpFiles: string[] = [];

function writeTmpYaml(contents: string): string {
  const filePath = path.join(os.tmpdir(), `mobilehub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(filePath, contents, 'utf8');
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop();
    if (f && fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('loadEffectiveConfig', () => {
  it('falls back to platform defaults when neither file exists', async () => {
    const result = await loadEffectiveConfig(
      path.join(os.tmpdir(), 'does-not-exist-org.yaml'),
      path.join(os.tmpdir(), 'does-not-exist-project.yaml'),
    );
    expect(result).toEqual(PLATFORM_DEFAULTS);
  });

  it('loads, validates, and merges real org + project yaml files against mobile-hub\'s schema', async () => {
    const orgPath = writeTmpYaml('features:\n  streaming: false\nbuild:\n  provider: s3\n');
    const projectPath = writeTmpYaml('build:\n  s3:\n    bucket: my-bucket\n');

    const result = await loadEffectiveConfig(orgPath, projectPath);
    expect(result.features.streaming).toBe(false);
    expect(result.build.provider).toBe('s3');
    expect(result.build.s3.bucket).toBe('my-bucket');
  });

  it('surfaces a ConfigError (from layered-config-ts) on a typo\'d key', async () => {
    const orgPath = writeTmpYaml('features:\n  buidls: false\n'); // typo: buidls
    await expect(loadEffectiveConfig(orgPath, path.join(os.tmpdir(), 'missing.yaml'))).rejects.toThrow(ConfigError);
  });
});

describe('project resolution', () => {
  it('inherits org automation and overrides only what a project declares', () => {
    const orgAutomation = {
      runner: 'wdio',
      framework: 'cucumber',
      configPath: 'wdio.conf.js',
      testDir: 'test',
      repoUrl: 'https://example.com/org-default.git',
      install: null,
      run: null,
      env: {},
    };

    const resolved = resolveProjects(
      {
        // Declares nothing: must still be selectable, fully inheriting.
        inheritor: {},
        // Overrides two fields; the rest must survive from the org block.
        overrider: { displayName: 'Checkout', automation: { testDir: 'e2e', repoUrl: 'https://example.com/own.git' } },
      },
      orgAutomation,
    );

    expect(resolved.inheritor.automation).toEqual(orgAutomation);
    // A project that doesn't name itself is shown by its id.
    expect(resolved.inheritor.displayName).toBe('inheritor');

    expect(resolved.overrider.automation.testDir).toBe('e2e');
    expect(resolved.overrider.automation.repoUrl).toBe('https://example.com/own.git');
    // Not overridden, so it must still be the org value — the bug this guards
    // against is a partial override silently blanking its siblings.
    expect(resolved.overrider.automation.configPath).toBe('wdio.conf.js');
    expect(resolved.overrider.automation.framework).toBe('cucumber');
  });

  it('reads the pre-split framework key: appium = wdio + cucumber, wdio = runner only', () => {
    const resolved = resolveProjects(
      {
        legacyAppium: { automation: { framework: 'appium' } },
        legacyWdio: { automation: { framework: 'wdio' } },
        explicit: { automation: { runner: 'wdio', framework: 'mocha' } },
      },
      PLATFORM_DEFAULTS.automation,
    );
    expect(resolved.legacyAppium.automation).toMatchObject({ runner: 'wdio', framework: 'cucumber' });
    expect(resolved.legacyWdio.automation).toMatchObject({ runner: 'wdio', framework: 'unspecified' });
    expect(resolved.explicit.automation).toMatchObject({ runner: 'wdio', framework: 'mocha' });
  });

  it('rejects the removed envFile key instead of silently ignoring it', async () => {
    const orgPath = writeTmpYaml('automation:\n  envFile: .env\n');
    await expect(loadEffectiveConfig(orgPath, path.join(os.tmpdir(), 'missing.yaml'))).rejects.toThrow(ConfigError);
  });

  it('returns nothing when no projects are declared', () => {
    expect(resolveProjects(undefined, PLATFORM_DEFAULTS.automation)).toEqual({});
  });
});
