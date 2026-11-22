import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as supervisor from '../../../common/process-supervisor';
import { env } from '../../../config/env';
import { PLATFORM_DEFAULTS, AutomationConfig } from '../../../config/org-config.schema';
import { branchRefSchema, discoverSuites, SuiteDiscoveryError } from './suites.service';

describe('branchRefSchema', () => {
  it.each(['main', 'feature/login', 'release-1.2', 'user_x/fix.thing'])('accepts %s', (b) => {
    expect(branchRefSchema.safeParse(b).success).toBe(true);
  });

  it.each([
    '-upload-pack=evil',
    '--help',
    '',
    'a..b',
    'a b',
    'a;rm',
    'a$(x)',
    'a@{1}',
    '/leading',
    'trailing/',
    'x.lock',
    'a//b',
    'tab\there',
  ])('rejects %j', (b) => {
    expect(branchRefSchema.safeParse(b).success).toBe(false);
  });
});

/**
 * The clone is stubbed by a fake `git` that writes a checkout whose feature
 * file is named after the requested branch, so each assertion can tell which
 * branch a result was read from without a real git host.
 */
describe('discoverSuites branch handling', () => {
  let tmp: string;
  let origDir: string;
  let cloneArgs: string[][];
  const automation: AutomationConfig = {
    ...PLATFORM_DEFAULTS.automation,
    framework: 'appium',
    repoUrl: 'https://example.com/suites-test.git',
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-suites-test-'));
    origDir = env.EXECUTIONS_DIR;
    env.EXECUTIONS_DIR = tmp;
    cloneArgs = [];
    vi.spyOn(supervisor, 'run').mockImplementation((opts) => {
      if (opts.args?.[0] === 'clone') {
        cloneArgs.push(opts.args);
        const dir = opts.args[opts.args.length - 1];
        const branchIdx = opts.args.indexOf('--branch');
        const branch = branchIdx === -1 ? 'default' : opts.args[branchIdx + 1];
        const testDir = path.join(dir, automation.testDir);
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(path.join(testDir, 'only.feature'), `Feature: on ${branch}\n`);
      }
      return { result: Promise.resolve({ kind: 'exited', exitCode: 0 }), pid: 1, cancel: () => {} };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.EXECUTIONS_DIR = origDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const names = (suites: { name: string }[]) => suites.map((s) => s.name);

  it('reads the default branch when none is given, with no --branch flag', async () => {
    const suites = await discoverSuites('p-default', automation);
    expect(names(suites)).toEqual(['on default']);
    expect(cloneArgs[0]).not.toContain('--branch');
  });

  it('clones the requested branch and keeps git options out of the repo slot', async () => {
    const suites = await discoverSuites('p-branch', automation, { branch: 'feature/x' });
    expect(names(suites)).toEqual(['on feature/x']);
    const args = cloneArgs[0];
    expect(args.slice(args.indexOf('--branch'), args.indexOf('--branch') + 2)).toEqual(['--branch', 'feature/x']);
    expect(args[args.indexOf('--') + 1]).toBe(automation.repoUrl);
  });

  it('caches per project + branch, so one branch never answers for another', async () => {
    expect(names(await discoverSuites('p-cache', automation, { branch: 'a' }))).toEqual(['on a']);
    expect(names(await discoverSuites('p-cache', automation, { branch: 'b' }))).toEqual(['on b']);
    expect(names(await discoverSuites('p-cache', automation))).toEqual(['on default']);
    expect(cloneArgs).toHaveLength(3);

    // Repeat calls are served from the cache: no further git work at all.
    const callsBefore = vi.mocked(supervisor.run).mock.calls.length;
    expect(names(await discoverSuites('p-cache', automation, { branch: 'a' }))).toEqual(['on a']);
    expect(vi.mocked(supervisor.run).mock.calls.length).toBe(callsBefore);
  });

  it('reports a branch that cannot be cloned as a discovery error, not a crash', async () => {
    vi.mocked(supervisor.run).mockImplementation(() => ({
      result: Promise.resolve({ kind: 'exited', exitCode: 128 }),
      pid: 1,
      cancel: () => {},
    }));
    await expect(discoverSuites('p-missing', automation, { branch: 'gone' })).rejects.toThrow(SuiteDiscoveryError);
  });
});
