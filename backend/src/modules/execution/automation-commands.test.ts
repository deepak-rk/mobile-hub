import { describe, it, expect } from 'vitest';
import { PLATFORM_DEFAULTS, AutomationConfig } from '../../config/org-config.schema';
import {
  canDeriveCommands,
  resolveInstallCommand,
  resolveRunCommand,
  UnsupportedFrameworkError,
} from './automation-commands';

/**
 * The point of this module: `framework`/`configPath` were accepted by config
 * and read by nothing, so every trigger still had to be handed literal npm
 * commands. These pin that the config now decides, and that an explicit
 * command still wins over it.
 */
function automation(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return { ...PLATFORM_DEFAULTS.automation, ...overrides };
}

describe('resolveRunCommand', () => {
  it('builds a wdio invocation from the configured config file', () => {
    const cmd = resolveRunCommand(automation({ configPath: 'wdio.conf.ts' }));
    expect(cmd).toEqual({ command: 'npx', args: ['wdio', 'run', 'wdio.conf.ts'] });
  });

  it('passes the suite as an argument rather than interpolating it', () => {
    // Commands are spawned directly, never through a shell, so a suite name
    // with spaces or quotes is just one argument and needs no escaping.
    const cmd = resolveRunCommand(automation(), 'smoke tests');
    expect(cmd.args).toEqual(['wdio', 'run', 'wdio.conf.js', '--suite', 'smoke tests']);
  });

  it('treats appium and wdio as the same runner', () => {
    expect(resolveRunCommand(automation({ framework: 'wdio' }))).toEqual(
      resolveRunCommand(automation({ framework: 'appium' })),
    );
  });

  it('prefers an explicitly configured run command over anything derived', () => {
    // A config that cannot be overridden is a cage rather than a default.
    const cmd = resolveRunCommand(automation({ run: { command: 'make', args: ['e2e'] } }), 'smoke');
    expect(cmd).toEqual({ command: 'make', args: ['e2e'] });
  });

  it('refuses to guess for a framework it does not know', () => {
    expect(() => resolveRunCommand(automation({ framework: 'espresso' }))).toThrow(UnsupportedFrameworkError);
    // The error has to name both ways out, since it surfaces as a 400.
    expect(() => resolveRunCommand(automation({ framework: 'espresso' }))).toThrow(/supply an explicit run command/i);
  });
});

describe('resolveInstallCommand', () => {
  it('defaults to npm ci for a known framework', () => {
    expect(resolveInstallCommand(automation())).toEqual({ command: 'npm', args: ['ci'] });
  });

  it('lets a project choose npm install instead, so a restored cache survives', () => {
    // npm ci deletes node_modules first, discarding the cache the previous
    // stage just restored — which is why this is a config choice, not a
    // hardcoded one.
    const cmd = resolveInstallCommand(automation({ install: { command: 'npm', args: ['install'] } }));
    expect(cmd).toEqual({ command: 'npm', args: ['install'] });
  });

  it('assumes nothing for an unknown framework', () => {
    expect(resolveInstallCommand(automation({ framework: 'espresso' }))).toBeNull();
  });
});

describe('canDeriveCommands', () => {
  it('is true for a known framework and for an explicit command', () => {
    expect(canDeriveCommands(automation())).toBe(true);
    expect(canDeriveCommands(automation({ framework: 'gradle', run: { command: 'gradle', args: ['test'] } }))).toBe(
      true,
    );
  });

  it('is false when nothing tells us how to run', () => {
    expect(canDeriveCommands(automation({ framework: 'gradle' }))).toBe(false);
  });
});

describe('suite selector shape', () => {
  // Three different things that `--suite` alone conflates. Passing a feature
  // path to `--suite` failed against a real run with "the suite you specified
  // doesn't exist", which is what these pin.
  it('uses --spec for a feature path', () => {
    const cmd = resolveRunCommand(automation(), 'test/features/app-launch.feature');
    expect(cmd.args).toEqual(['wdio', 'run', 'wdio.conf.js', '--spec', 'test/features/app-launch.feature']);
  });

  it('uses a tag expression for a Cucumber tag', () => {
    const cmd = resolveRunCommand(automation(), '@smoke');
    expect(cmd.args).toEqual(['wdio', 'run', 'wdio.conf.js', '--cucumberOpts.tagExpression', '@smoke']);
  });

  it('uses --suite for a plain name defined in the runner config', () => {
    const cmd = resolveRunCommand(automation(), 'regression');
    expect(cmd.args).toEqual(['wdio', 'run', 'wdio.conf.js', '--suite', 'regression']);
  });
});
