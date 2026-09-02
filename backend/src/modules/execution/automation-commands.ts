import { AutomationConfig } from '../../config/org-config.schema';
import { RunCommand } from './execution.service';

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

/** Frameworks whose invocation this module knows how to build. */
const KNOWN_FRAMEWORKS = ['appium', 'wdio'] as const;

export class UnsupportedFrameworkError extends Error {
  constructor(framework: string) {
    super(
      `No run command is known for framework '${framework}'. ` +
        `Either supply an explicit run command with the trigger, or configure one of: ${KNOWN_FRAMEWORKS.join(', ')}.`,
    );
    this.name = 'UnsupportedFrameworkError';
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
  if (!isKnownFramework(automation.framework)) return null;
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

  if (!isKnownFramework(automation.framework)) {
    throw new UnsupportedFrameworkError(automation.framework);
  }

  // Both 'appium' and 'wdio' mean the same runner here: mobile-hub's own
  // default is 'appium', while a team naming the runner directly writes 'wdio'.
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
function selectorArgsFor(suite: string): string[] {
  if (suite.startsWith('@')) {
    // Cucumber selects by tag expression, not by name.
    return ['--cucumberOpts.tagExpression', suite];
  }
  if (suite.includes('/') || suite.endsWith('.feature')) {
    return ['--spec', suite];
  }
  return ['--suite', suite];
}

function isKnownFramework(framework: string): boolean {
  return (KNOWN_FRAMEWORKS as readonly string[]).includes(framework);
}

/**
 * Whether a project is configured well enough to run without the caller
 * supplying commands — what the trigger form needs in order to stop asking.
 */
export function canDeriveCommands(automation: AutomationConfig): boolean {
  return Boolean(automation.run) || isKnownFramework(automation.framework);
}
