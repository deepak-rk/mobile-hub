import { AutomationConfig } from '../../../config/org-config.schema';

/**
 * One thing a user can choose to run.
 *
 * `id` is what lands on `ExecutionRun.suite` and what the runner is asked for,
 * so it must round-trip exactly. `name` exists only to read better in a
 * dropdown — a feature file's own title is friendlier than its path.
 */
export interface DiscoveredSuite {
  id: string;
  name: string;
  /**
   * How this suite is addressed:
   *  - `tag`     a Cucumber tag (`@smoke`), selecting across files
   *  - `feature` a single feature file, selected by path
   *
   * Kept because the two are passed to a runner differently, and because a
   * dropdown mixing them without saying so would be confusing.
   */
  kind: 'tag' | 'feature';
  /** Repo-relative path, for a `feature`; absent for a tag spanning files. */
  file?: string;
  /** How many feature files carry this tag. Only meaningful for `tag`. */
  fileCount?: number;
}

/**
 * Discovers what can be run in an automation repo.
 *
 * One adapter per framework, the same shape as `BuildProvider` and
 * `CaptureSource`: adding a framework means writing an adapter, not editing
 * the caller. Discovery is deliberately *static* — reading files, never
 * executing the repo's own config — because running a checkout's code to find
 * out what it contains would execute arbitrary code from a git URL an operator
 * typed into a YAML file.
 */
export interface SuiteProvider {
  readonly framework: string;
  discover(repoDir: string, automation: AutomationConfig): Promise<DiscoveredSuite[]>;
}

/**
 * Pulls tags and the feature title out of one `.feature` file's text.
 *
 * Exported for testing: this is the part that actually breaks. Gherkin allows
 * tags on the feature, on scenarios, and on examples; they may share a line or
 * sit on their own; and `@` appears inside ordinary prose and email addresses
 * in step text, which must not be mistaken for a tag.
 */
export function parseFeatureFile(text: string): { title: string | null; tags: string[] } {
  const tags = new Set<string>();
  let title: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (title === null) {
      const match = /^Feature:\s*(.+)$/.exec(line);
      if (match) title = match[1].trim();
    }

    // A tag line contains only tags. Requiring the line to *start* with `@` is
    // what keeps `contact @support` inside a step from registering as a tag —
    // step text never begins with one.
    if (!line.startsWith('@')) continue;
    for (const token of line.split(/\s+/)) {
      if (/^@[\w-]+$/.test(token)) tags.add(token);
    }
  }

  return { title, tags: [...tags] };
}
