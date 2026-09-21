import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { summarizeAllureResults, summarizeRunResults, ALLURE_RESULTS_DIRNAME } from './allure-summary';

/**
 * Real files in a temp dir, since the whole job is reading a directory a
 * runner wrote. The fixtures mirror the shape a real WDIO+Allure run produced
 * in the sibling automation repo — `uuid`, `historyId`, `status`, `stop`, and
 * a `labels` array — rather than a minimal invention, so a field this parser
 * relies on cannot quietly be one that Allure never writes.
 */
let dir: string;

interface ResultFixture {
  status?: string;
  historyId?: string;
  stop?: number;
  name?: string;
  message?: string;
}

function writeResult(id: string, fixture: ResultFixture): void {
  fs.writeFileSync(
    path.join(dir, `${id}-result.json`),
    JSON.stringify({
      uuid: id,
      name: fixture.name ?? 'a test',
      historyId: fixture.historyId,
      status: fixture.status,
      statusDetails: fixture.message ? { message: fixture.message, trace: 'at Object.<anonymous>…' } : {},
      stage: 'finished',
      start: (fixture.stop ?? 1000) - 100,
      stop: fixture.stop ?? 1000,
      labels: [{ name: 'framework', value: 'wdio' }],
    }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-allure-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('summarizeAllureResults', () => {
  it('counts each Allure status and computes a test-level pass rate', () => {
    writeResult('a', { status: 'passed', historyId: 'h1' });
    writeResult('b', { status: 'passed', historyId: 'h2' });
    writeResult('c', { status: 'failed', historyId: 'h3' });
    writeResult('d', { status: 'broken', historyId: 'h4' });
    writeResult('e', { status: 'skipped', historyId: 'h5' });

    expect(summarizeAllureResults(dir)).toEqual({
      total: 5,
      passed: 2,
      failed: 1,
      broken: 1,
      skipped: 1,
      unknown: 0,
      passRate: 2 / 5,
      failures: [],
      testCases: [
        { id: 'h1', name: 'a test', status: 'passed' },
        { id: 'h2', name: 'a test', status: 'passed' },
        { id: 'h3', name: 'a test', status: 'failed' },
        { id: 'h4', name: 'a test', status: 'broken' },
        { id: 'h5', name: 'a test', status: 'skipped' },
      ],
    });
  });

  it('groups failures by message and orders them by how many tests hit each', () => {
    // The counts are the point: twenty tests failing on one message is one
    // problem, twenty failing on twenty messages is twenty, and a bare failed
    // count cannot tell those apart.
    writeResult('a', { status: 'failed', historyId: 'h1', message: 'Expected ~Home-screen within 20s' });
    writeResult('b', { status: 'failed', historyId: 'h2', message: 'Expected ~Home-screen within 20s' });
    writeResult('c', { status: 'failed', historyId: 'h3', message: 'Expected a confirmation alert' });
    writeResult('d', { status: 'passed', historyId: 'h4' });

    expect(summarizeAllureResults(dir)?.failures).toEqual([
      { message: 'Expected ~Home-screen within 20s', count: 2 },
      { message: 'Expected a confirmation alert', count: 1 },
    ]);
  });

  it('groups on the first line only, so a differing stack does not split one reason', () => {
    // Allure's message is often an assertion line followed by a stack, and the
    // stack differs per test — grouping on the whole thing would put every
    // failure in its own bucket and defeat the count entirely.
    writeResult('a', { status: 'failed', historyId: 'h1', message: 'Timed out\n  at loginPage.ts:14' });
    writeResult('b', { status: 'failed', historyId: 'h2', message: 'Timed out\n  at homePage.ts:31' });

    expect(summarizeAllureResults(dir)?.failures).toEqual([{ message: 'Timed out', count: 2 }]);
  });

  it('counts broken tests as failures too', () => {
    // An assertion that came out false and a test that errored are different
    // kinds of problem, but "why is this red" wants both answers.
    writeResult('a', { status: 'broken', historyId: 'h1', message: 'Cannot read properties of undefined' });

    expect(summarizeAllureResults(dir)?.failures).toEqual([
      { message: 'Cannot read properties of undefined', count: 1 },
    ]);
  });

  it('counts only the surviving attempt of a retried failure', () => {
    // Same collapse as the totals: a test retried twice and still failing is
    // one failure, not two, or the counts would exaggerate the blast radius.
    writeResult('try1', { status: 'failed', historyId: 'flaky', stop: 100, message: 'Timed out' });
    writeResult('try2', { status: 'failed', historyId: 'flaky', stop: 200, message: 'Timed out' });

    expect(summarizeAllureResults(dir)?.failures).toEqual([{ message: 'Timed out', count: 1 }]);
  });

  it('is empty when a failure carried no message to group by', () => {
    writeResult('a', { status: 'failed', historyId: 'h1' });

    expect(summarizeAllureResults(dir)).toMatchObject({ failed: 1, failures: [] });
  });

  it('is the whole point: 143 of 145 passing reads as 98.6%, not as a failed run', () => {
    for (let i = 0; i < 143; i += 1) writeResult(`p${i}`, { status: 'passed', historyId: `hp${i}` });
    writeResult('f1', { status: 'failed', historyId: 'hf1' });
    writeResult('f2', { status: 'failed', historyId: 'hf2' });

    const summary = summarizeAllureResults(dir);

    expect(summary?.total).toBe(145);
    expect(summary?.passRate).toBeCloseTo(0.986, 3);
  });

  it('collapses retries of one test rather than counting each attempt', () => {
    // A retried test writes one file per attempt, all sharing a historyId —
    // which is how Allure's own report shows retries under a single test.
    // Counting files would report this flaky-but-passing test as both a pass
    // and a failure, and inflate the total from 1 to 3.
    writeResult('attempt1', { status: 'failed', historyId: 'flaky', stop: 100 });
    writeResult('attempt2', { status: 'failed', historyId: 'flaky', stop: 200 });
    writeResult('attempt3', { status: 'passed', historyId: 'flaky', stop: 300 });

    expect(summarizeAllureResults(dir)).toMatchObject({ total: 1, passed: 1, failed: 0, passRate: 1 });
  });

  it('keeps the latest attempt regardless of directory order', () => {
    // Filenames are uuids, so readdir order says nothing about attempt order —
    // only `stop` does. Written newest-first here to catch a parser that just
    // takes whichever it sees last.
    writeResult('zzz', { status: 'passed', historyId: 'flaky', stop: 300 });
    writeResult('aaa', { status: 'failed', historyId: 'flaky', stop: 100 });

    expect(summarizeAllureResults(dir)).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it('ignores attachments and containers, which are not tests', () => {
    // In a real run here these outnumbered the results 65 to 1, so counting
    // every json file would have reported ~1180 tests instead of 18.
    writeResult('a', { status: 'passed', historyId: 'h1' });
    fs.writeFileSync(path.join(dir, 'x-attachment.json'), '{"status":"failed"}');
    fs.writeFileSync(path.join(dir, 'y-container.json'), '{"status":"failed"}');
    fs.writeFileSync(path.join(dir, 'z-attachment.png'), 'not json');

    expect(summarizeAllureResults(dir)).toMatchObject({ total: 1, passed: 1 });
  });

  it('counts a missing or unrecognised status as unknown rather than dropping the test', () => {
    writeResult('a', { status: 'passed', historyId: 'h1' });
    writeResult('b', { historyId: 'h2' });
    writeResult('c', { status: 'unknown', historyId: 'h3' });

    expect(summarizeAllureResults(dir)).toMatchObject({ total: 3, passed: 1, unknown: 2 });
  });

  it('keeps skipped tests in the denominator', () => {
    // A suite that skips half its tests has not passed 100% of what it set out
    // to run; excluding them would let a broken filter read as a perfect score.
    writeResult('a', { status: 'passed', historyId: 'h1' });
    writeResult('b', { status: 'skipped', historyId: 'h2' });

    expect(summarizeAllureResults(dir)?.passRate).toBe(0.5);
  });

  it('survives one malformed file rather than discarding the rest', () => {
    writeResult('a', { status: 'passed', historyId: 'h1' });
    writeResult('b', { status: 'passed', historyId: 'h2' });
    fs.writeFileSync(path.join(dir, 'truncated-result.json'), '{"status": "pas');

    expect(summarizeAllureResults(dir)).toMatchObject({ total: 2, passed: 2 });
  });

  it('returns null for a missing directory, not an empty summary', () => {
    // "No Allure output" and "ran zero tests" are different facts. A project
    // not using Allure must not start reporting 0/0 as though its suite were
    // empty.
    expect(summarizeAllureResults(path.join(dir, 'nope'))).toBeNull();
  });

  it('returns null when the directory holds no results', () => {
    fs.writeFileSync(path.join(dir, 'only-attachment.json'), '{}');
    expect(summarizeAllureResults(dir)).toBeNull();
  });
});

describe('summarizeRunResults', () => {
  it('finds results in the checkout when a repo was cloned', () => {
    const repoResults = path.join(dir, 'repo', ALLURE_RESULTS_DIRNAME);
    fs.mkdirSync(repoResults, { recursive: true });
    fs.writeFileSync(path.join(repoResults, 'a-result.json'), JSON.stringify({ status: 'passed', historyId: 'h' }));

    expect(summarizeRunResults(dir, ALLURE_RESULTS_DIRNAME)).toMatchObject({ total: 1, passed: 1 });
  });

  it('falls back to the workspace root when no repo was cloned', () => {
    // The runner's cwd is the checkout when there is one and the workspace
    // root otherwise — same two candidates the report collector checks.
    const rootResults = path.join(dir, ALLURE_RESULTS_DIRNAME);
    fs.mkdirSync(rootResults, { recursive: true });
    fs.writeFileSync(path.join(rootResults, 'a-result.json'), JSON.stringify({ status: 'failed', historyId: 'h' }));

    expect(summarizeRunResults(dir, ALLURE_RESULTS_DIRNAME)).toMatchObject({ total: 1, failed: 1, passRate: 0 });
  });

  it('returns null when neither location has results', () => {
    expect(summarizeRunResults(dir, ALLURE_RESULTS_DIRNAME)).toBeNull();
  });
});
