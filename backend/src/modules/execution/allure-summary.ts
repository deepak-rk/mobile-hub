import * as fs from 'fs';
import * as path from 'path';

/**
 * Test-case-level results, read from the Allure results a runner writes.
 *
 * Run-level and test-case-level pass rates answer different questions, and
 * until now only the first existed: a run where 143 of 145 tests passed is
 * *0%* at run level and *98.6%* at test level. `failureKind` already
 * separated an infrastructure failure from a test failure, but a suite where
 * one test of two hundred flaked still looked identical to one where all two
 * hundred failed.
 *
 * Allure's raw results are the source rather than the generated HTML report:
 * the report is a rendering of exactly this data, and parsing HTML to recover
 * numbers that were JSON one step earlier would be the wrong direction.
 */

/** Allure's own status vocabulary. `unknown` is its value for "never ran". */
export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
  /** Fraction of tests that passed, 0–1, or null when nothing ran. */
  passRate: number | null;
  /**
   * Why the failures failed, grouped by message and ordered by how many tests
   * hit each — the counts are the point. Twenty tests failing on one message
   * is one problem; twenty tests failing on twenty messages is twenty. A count
   * of failed tests alone cannot tell those apart, and they call for opposite
   * responses.
   *
   * Empty when nothing failed.
   */
  failures: FailureGroup[];
}

export interface FailureGroup {
  /** First line of Allure's `statusDetails.message`, truncated. */
  message: string;
  /** How many distinct tests failed with this message. */
  count: number;
}

export const ALLURE_RESULTS_DIRNAME = 'allure-results';

/**
 * Guards against a results directory that has accumulated many runs' output —
 * possible when a project points its runner at a directory it never cleans.
 * Reading is cheap per file but not free, and this runs in the same finally
 * block as workspace cleanup.
 */
const MAX_RESULT_FILES = 5000;

/**
 * How many distinct failure messages to keep, and how much of each.
 *
 * Bounded because this is persisted on every run: a suite failing in two
 * hundred different ways is itself the finding, and the top few carry it. The
 * full text stays in the log and the Allure results.
 */
const MAX_FAILURE_GROUPS = 5;
const MAX_FAILURE_MESSAGE_CHARS = 300;

/**
 * The one line worth grouping by.
 *
 * Allure's `message` is often an assertion line followed by a stack, and the
 * stack differs between two tests that failed for the same reason — grouping
 * on the whole thing would put every failure in its own bucket and defeat the
 * count. Real output here repeats the first line verbatim across tests
 * ("Expected ~Home-screen to be displayed within 20s"), which is what makes
 * exact grouping on it work without normalising.
 */
function failureMessageOf(result: AllureResult): string | null {
  const raw = result.statusDetails?.message?.trim();
  if (!raw) return null;
  const firstLine = raw.split('\n')[0].trim();
  if (!firstLine) return null;
  return firstLine.length > MAX_FAILURE_MESSAGE_CHARS
    ? `${firstLine.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…`
    : firstLine;
}

interface AllureResult {
  status?: string;
  statusDetails?: { message?: string; trace?: string };
  historyId?: string;
  testCaseId?: string;
  fullName?: string;
  name?: string;
  stop?: number;
  start?: number;
}

/**
 * One test's latest attempt, keyed so retries collapse.
 *
 * A retried test writes one result file per attempt, all with the same
 * `historyId` — which is how Allure's own report shows "3 retries" under a
 * single test rather than three tests. Counting files instead of tests would
 * inflate the total and, worse, report a flaky-but-eventually-passing test as
 * both a pass and a failure.
 *
 * Note what this deliberately does *not* distinguish: two attempts of one test
 * in the same run, and the same test in two different runs, look identical
 * here. That is safe only because a run clones into a fresh workspace that is
 * deleted afterwards, so a results directory only ever holds one run's output.
 * Pointed at a results directory that accumulates across runs, this collapses
 * to the latest attempt of each test — which is what happened when it was
 * first run against the sibling repo's checked-in results: 18 files, three
 * runs, 6 tests.
 */
function keyOf(result: AllureResult, fallback: string): string {
  return result.historyId ?? result.testCaseId ?? result.fullName ?? result.name ?? fallback;
}

function attemptOrder(result: AllureResult): number {
  return result.stop ?? result.start ?? 0;
}

/**
 * Reads `<dir>/*-result.json` into a summary, or null when there is nothing to
 * read.
 *
 * Null rather than an all-zero summary: "no results directory" and "a run that
 * executed zero tests" are different facts, and only the second is worth
 * showing as 0/0. A project not using Allure at all must not start reporting
 * an empty test count as though its suite were empty.
 */
export function summarizeAllureResults(dir: string): TestSummary | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  // `-result.json` only. The same directory holds `-attachment.*` files and
  // `-container.json` fixtures, which are not tests — in a real run here they
  // outnumbered the results 65 to 1.
  const files = entries.filter((f) => f.endsWith('-result.json')).slice(0, MAX_RESULT_FILES);
  if (files.length === 0) return null;

  const latest = new Map<string, AllureResult>();
  for (const file of files) {
    let parsed: AllureResult;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as AllureResult;
    } catch {
      // One malformed file must not discard the other 200 results. A partial
      // count is worth more here than nothing at all.
      continue;
    }
    const key = keyOf(parsed, file);
    const existing = latest.get(key);
    if (!existing || attemptOrder(parsed) >= attemptOrder(existing)) latest.set(key, parsed);
  }

  const summary: TestSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    broken: 0,
    skipped: 0,
    unknown: 0,
    passRate: null,
    failures: [],
  };

  const failureCounts = new Map<string, number>();

  for (const result of latest.values()) {
    summary.total += 1;
    switch (result.status) {
      case 'passed':
        summary.passed += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'broken':
        summary.broken += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
      default:
        // Allure writes `unknown`, and an absent status means the same thing.
        summary.unknown += 1;
    }

    // Both failed and broken: an assertion that came out false and a test that
    // errored are different kinds of problem, but an operator asking "why is
    // this red" wants both answers, not one.
    if (result.status === 'failed' || result.status === 'broken') {
      const message = failureMessageOf(result);
      if (message) failureCounts.set(message, (failureCounts.get(message) ?? 0) + 1);
    }
  }

  summary.failures = [...failureCounts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, MAX_FAILURE_GROUPS);

  if (summary.total === 0) return null;

  // Skipped tests stay in the denominator. A suite that skips half its tests
  // has not passed 100% of what it set out to run, and excluding them would
  // let a broken filter read as a perfect score.
  summary.passRate = summary.passed / summary.total;
  return summary;
}

/**
 * Finds the results directory for a finished run and summarizes it.
 *
 * Checks the same two locations as the report collector, and for the same
 * reason: the runner's cwd is the checkout when a repo was cloned and the
 * workspace root otherwise.
 */
export function summarizeRunResults(workspacePath: string, resultsDirName: string): TestSummary | null {
  const candidates = [path.join(workspacePath, 'repo', resultsDirName), path.join(workspacePath, resultsDirName)];
  for (const dir of candidates) {
    const summary = summarizeAllureResults(dir);
    if (summary) return summary;
  }
  return null;
}
