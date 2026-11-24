import * as fs from 'fs';
import * as path from 'path';
import { attemptOrder, keyOf, outcomeOf, type AllureResult, type TestCaseOutcome } from '../allure-summary';

/**
 * Reads a run's Allure results while the runner is still writing them, so the
 * status board can show each scenario as it finishes instead of all at once
 * at the end. The reporter writes one `*-result.json` per finished test.
 *
 * Incremental and bounded: each poll parses only files it has not parsed
 * yet, at most `maxPerPoll`, the rest on the next poll. A file that does not
 * parse is most likely half-written and is retried, not skipped.
 *
 * What it returns is never a final answer about the run (lesson 60: a capped
 * parse returned as final). A test absent here may simply not have finished;
 * only the end-of-run summary decides what the run did not reach.
 */
export interface LiveResultsReader {
  /** Outcomes that are new or changed since the previous poll. */
  poll(): TestCaseOutcome[];
}

export function createLiveResultsReader(dirs: string[], maxPerPoll = 200): LiveResultsReader {
  const parsed = new Set<string>();
  const latest = new Map<string, { order: number; outcome: TestCaseOutcome }>();

  return {
    poll() {
      const dir = dirs.find((d) => fs.existsSync(d));
      if (!dir) return [];
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const fresh = entries.filter((f) => f.endsWith('-result.json') && !parsed.has(f)).slice(0, maxPerPoll);

      const changed = new Map<string, TestCaseOutcome>();
      for (const file of fresh) {
        let result: AllureResult;
        try {
          result = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as AllureResult;
        } catch {
          continue;
        }
        parsed.add(file);
        const key = keyOf(result, file);
        const order = attemptOrder(result);
        const prev = latest.get(key);
        // Retries: the newest attempt wins, same rule as the final summary.
        if (prev && order < prev.order) continue;
        const outcome = outcomeOf(key, result);
        latest.set(key, { order, outcome });
        if (!prev || prev.outcome.status !== outcome.status) changed.set(key, outcome);
      }
      return [...changed.values()];
    },
  };
}
