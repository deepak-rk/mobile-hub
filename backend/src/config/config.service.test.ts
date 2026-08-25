import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigError } from 'layered-config-ts';
import { loadEffectiveConfig } from './config.service';
import { PLATFORM_DEFAULTS } from './org-config.schema';

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
