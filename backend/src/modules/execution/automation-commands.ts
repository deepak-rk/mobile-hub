import { AutomationConfig } from '../../config/org-config.schema';
import { RunCommand } from './execution.service';
import { ValidationError } from '../../common/errors/app-error';

/**
 * Turns a project's declared automation config into the commands to run.
 *
 * This is the point of declaring `framework`, `configPath` and `testDir` at
 * all. Until now those keys were accepted and read by nothing, so every
 * trigger still had to be handed a literal `npm ci` and
 * `npx wdio run wdio.conf.js` — the operator retyping what the config already
 * said, and free to type something that contradicts it.
 *
 * A caller may still pass explicit commands; those win, because a config that
 * cannot be overridden for a one-off is a cage rather than a default. The
 * difference is that supplying them is now the exception.
 */

/** Runners whose invocation this module knows how to build. */
const KNOWN_RUNNERS = ['wdio'] as const;

// A 400 ValidationError, not a 409/404 — the request itself is malformed
// (nothing usable was configured or supplied), matching what
// execution.routes.ts was already mapping this to under the code
// 'NO_RUN_COMMAND', now baked in here instead of a route-level instanceof check.
export class UnsupportedFrameworkError extends ValidationError {
  constructor(runner: string) {
    super(
      `No run command is known for runner '${runner}'. ` +
        `Either supply an explicit run command with the trigger, or set automation.runner to one of: ${KNOWN_RUNNERS.join(', ')}.`,
      'NO_RUN_COMMAND',
    );
  }
}

/**
 * How dependencies get installed before the suite runs.
 *
 * `npm ci` rather than `npm install` by default: it installs exactly the
 * lockfile, which is what makes a run reproducible. Note it also deletes
 * `node_modules` first, so it discards a restored cache — a project that wants
 * the cache to count should declare `install` as `npm install` instead. That
 * tradeoff is the org's to make, which is why it is a config key and not a
 * hardcoded choice.
 */
export function resolveInstallCommand(automation: AutomationConfig): RunCommand | null {
  if (automation.install) return automation.install;
  // Only meaningful for the JS frameworks this knows; anything else must
  // declare its own rather than have npm assumed on its behalf.
  if (!isKnownRunner(automation.runner)) return null;
  return { command: 'npm', args: ['ci'] };
}

/**
 * The command that actually runs the suite.
 *
 * `suite` is passed through to the runner rather than being interpolated into
 * a shell string — commands are spawned directly, never through a shell, so a
 * suite name containing spaces or quotes is just an argument.
 */
export function resolveRunCommand(automation: AutomationConfig, suite?: string): RunCommand {
  if (automation.run) return automation.run;

  if (!isKnownRunner(automation.runner)) {
    throw new UnsupportedFrameworkError(automation.runner);
  }

  const args = ['wdio', 'run', automation.configPath];
  if (suite) args.push(...selectorArgsFor(suite));
  return { command: 'npx', args };
}

/**
 * The right WebdriverIO flag for how this suite is addressed.
 *
 * These are three different things and `--suite` only means the first:
 *  - a *named* suite, defined in the runner's own `suites: {}` map
 *  - a *spec path*, which is `--spec`
 *  - a Cucumber *tag*, which is a tag expression
 *
 * Passing a feature path to `--suite` fails with "the suite you specified
 * doesn't exist" — confirmed against a real run, after suite discovery started
 * returning paths. The shape is inferred rather than carried alongside the id
 * because `ExecutionRun.suite` is a single string that has to round-trip
 * through history, and these three forms cannot be confused for one another:
 * a tag always starts with `@`, and a spec always looks like a path.
 */
export type SuiteKind = 'tag' | 'feature' | 'name';

/**
 * Which of the three a suite string is. Exported because analytics needs the
 * same answer the runner flags do — a tag and a feature path select different
 * sets, so comparing them as one suite is what made flakiness untrustworthy.
 * Deriving it in two places would let the two drift.
 */
export function classifySuite(suite: string): SuiteKind {
  if (suite.startsWith('@')) return 'tag';
  if (suite.includes('/') || suite.endsWith('.feature')) return 'feature';
  return 'name';
}

function selectorArgsFor(suite: string): string[] {
  switch (classifySuite(suite)) {
    case 'tag':
      // Cucumber selects by tag expression, not by name.
      return ['--cucumberOpts.tagExpression', suite];
    case 'feature':
      return ['--spec', suite];
    default:
      return ['--suite', suite];
  }
}

function isKnownRunner(runner: string): boolean {
  return (KNOWN_RUNNERS as readonly string[]).includes(runner);
}

/**
 * Whether a project is configured well enough to run without the caller
 * supplying commands — what the trigger form needs in order to stop asking.
 */
export function canDeriveCommands(automation: AutomationConfig): boolean {
  return Boolean(automation.run) || isKnownRunner(automation.runner);
}
