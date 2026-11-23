import { describe, it, expect } from 'vitest';
import type { AutomationConfig } from '../../config/org-config.schema';
import type { TestCaseOutcome } from './allure-summary';
import { resolveRunCommand } from './automation-commands';
import { failedTestSelection, selectionArgs } from './rerun-selection';

const cucumber = { runner: 'wdio', framework: 'cucumber', configPath: 'wdio.conf.ts' } as AutomationConfig;

const tc = (over: Partial<TestCaseOutcome>): TestCaseOutcome => ({
  id: 'x',
  name: 'test/features/a.feature#A Scenario',
  status: 'failed',
  ...over,
});

describe('failedTestSelection', () => {
  it('selects the failed and broken tests by feature file and scenario name', () => {
    const sel = failedTestSelection([
      tc({ id: '1', name: 'test/features/login.feature#Login Signs in', title: 'Signs in' }),
      tc({ id: '2', name: 'test/features/login.feature#Login Signs out', title: 'Signs out', status: 'broken' }),
      tc({ id: '3', name: 'test/features/cart.feature#Cart Adds (2) items', title: 'Adds (2) items' }),
      tc({ id: '4', name: 'test/features/cart.feature#Cart Empties', title: 'Empties', status: 'passed' }),
    ]);
    expect(sel).toEqual({
      specs: ['test/features/login.feature', 'test/features/cart.feature'],
      names: ['Signs in', 'Signs out', 'Adds (2) items'],
      testIds: ['1', '2', '3'],
    });
  });

  it('refuses when nothing failed', () => {
    expect(() => failedTestSelection([tc({ status: 'passed', title: 'A' })])).toThrow(/no failed tests/);
    expect(() => failedTestSelection(undefined)).toThrow(/no failed tests/);
  });

  it('refuses rather than silently rerunning only some failures', () => {
    // No scenario title (a run recorded before titles were kept).
    expect(() => failedTestSelection([tc({ title: undefined })])).toThrow(/Cannot pin down/);
    // Not a feature path, or one that climbs out of the checkout.
    expect(() => failedTestSelection([tc({ name: 'Login Signs in', title: 'Signs in' })])).toThrow(/Cannot pin down/);
    expect(() => failedTestSelection([tc({ name: '../x.feature#X Y', title: 'Y' })])).toThrow(/Cannot pin down/);
  });
});

describe('selectionArgs', () => {
  it('names each spec and anchors each scenario name as an escaped regex', () => {
    const args = selectionArgs(cucumber, { specs: ['a.feature', 'b.feature'], names: ['Adds (2) items', 'Pays $5'], testIds: [] });
    expect(args).toEqual([
      '--spec', 'a.feature',
      '--spec', 'b.feature',
      '--cucumberOpts.name', '^Adds \\(2\\) items$',
      '--cucumberOpts.name', '^Pays \\$5$',
    ]);
    expect(new RegExp(args[5]).test('Adds (2) items')).toBe(true);
    expect(new RegExp(args[5]).test('Adds (2) items twice')).toBe(false);
  });

  it('repeats a single name so the runner receives a list', () => {
    const args = selectionArgs(cucumber, { specs: ['a.feature'], names: ['One'], testIds: [] });
    expect(args.filter((a) => a === '--cucumberOpts.name')).toHaveLength(2);
  });

  it('is refused for a custom run command or a non-Cucumber framework', () => {
    const sel = { specs: ['a.feature'], names: ['One'], testIds: [] };
    expect(() => selectionArgs({ ...cucumber, framework: 'mocha' } as AutomationConfig, sel)).toThrow(/WebdriverIO \+ Cucumber/);
    expect(() => selectionArgs({ ...cucumber, run: { command: 'make', args: ['test'] } } as AutomationConfig, sel)).toThrow();
  });

  it('replaces the suite selector in the run command', () => {
    const cmd = resolveRunCommand(cucumber, '@smoke', ['--spec', 'a.feature']);
    expect(cmd.args).toEqual(['wdio', 'run', 'wdio.conf.ts', '--spec', 'a.feature']);
    expect(resolveRunCommand(cucumber, '@smoke').args).toContain('--cucumberOpts.tagExpression');
  });
});
