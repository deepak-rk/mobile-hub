import { ConflictError } from '../../common/errors/app-error';
import type { AutomationConfig } from '../../config/org-config.schema';
import type { TestCaseOutcome } from './allure-summary';

/**
 * Rerun-failed-only: which tests of a finished run to run again, and the
 * runner arguments that select exactly those.
 *
 * Selection is by feature file plus exact scenario name, both read from the
 * run's own results. Cucumber has no stable scenario id across runs, and line
 * numbers are not in Allure's output, so the name is the narrowest selector
 * available. A Scenario Outline's examples share one name, so all of an
 * outline's examples rerun when any of them failed.
 */
export interface RerunSelection {
  /** Feature files holding at least one failed test. */
  specs: string[];
  /** Exact scenario names of the failed tests. */
  names: string[];
  /** The failed tests' ids, recorded on the rerun. */
  testIds: string[];
}

export class RerunNotPossibleError extends ConflictError {
  constructor(message: string, code = 'RERUN_FAILED_NOT_POSSIBLE') {
    super(message, code);
  }
}

const FAILED = new Set(['failed', 'broken']);

/** A repo-relative feature path: no absolute paths, no climbing out of the checkout. */
function safeFeaturePath(spec: string): boolean {
  return (
    /^[A-Za-z0-9_./ -]+\.feature$/.test(spec) &&
    !spec.startsWith('/') &&
    !spec.split('/').includes('..')
  );
}

/**
 * The failed tests of a run, as a selection. Throws when nothing failed, or
 * when any failed test cannot be pinned down: rerunning "some of the failures"
 * would read as a clean rerun while silently skipping the rest.
 */
export function failedTestSelection(testCases: TestCaseOutcome[] | undefined): RerunSelection {
  const failed = (testCases ?? []).filter((t) => FAILED.has(t.status));
  if (failed.length === 0) {
    throw new RerunNotPossibleError('This run has no failed tests to rerun.', 'NOTHING_TO_RERUN');
  }
  const specs = new Set<string>();
  const names = new Set<string>();
  for (const t of failed) {
    // WebdriverIO's Allure reporter writes Cucumber's fullName as
    // `<feature path>#<feature> <scenario>`; the scenario alone is `title`.
    const spec = t.name.includes('#') ? t.name.slice(0, t.name.indexOf('#')) : '';
    if (!t.title || !safeFeaturePath(spec)) {
      throw new RerunNotPossibleError(
        `Cannot pin down failed test "${t.name}" to a feature file and scenario name; rerun the whole suite instead.`,
      );
    }
    specs.add(spec);
    names.add(t.title);
  }
  return { specs: [...specs], names: [...names], testIds: failed.map((t) => t.id) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runner arguments that run only `selection`. Cucumber only: the selection is
 * made of feature files and scenario names, which mean nothing to Mocha or
 * Jasmine.
 */
export function selectionArgs(automation: AutomationConfig, selection: RerunSelection): string[] {
  if (automation.run || automation.framework !== 'cucumber') {
    throw new RerunNotPossibleError(
      'Rerunning only failed tests needs the built-in WebdriverIO + Cucumber commands; this project uses its own run command or another framework.',
      'RERUN_FAILED_UNSUPPORTED',
    );
  }
  const args: string[] = [];
  for (const spec of selection.specs) args.push('--spec', spec);
  const patterns = selection.names.map((n) => `^${escapeRegExp(n)}$`);
  // Cucumber's name filter calls `.some()` on this option, so it must arrive
  // as a list. The CLI parser makes a list only from a repeated flag, so a
  // single name is passed twice; a duplicate pattern changes nothing.
  if (patterns.length === 1) patterns.push(patterns[0]);
  for (const p of patterns) args.push('--cucumberOpts.name', p);
  return args;
}
