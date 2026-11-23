import { Types } from 'mongoose';
import { NotFoundError } from '../../common/errors/app-error';
import { ExecutionRun, IExecutionRun } from './execution-run.model';
import type { TestCaseOutcome } from './allure-summary';

/**
 * One result per test across a run and all its reruns: "after the reruns,
 * where does this execution stand". Each test's newest result wins, by when
 * its run ended (a failed-only rerun only re-reports the tests it ran, so
 * the rest keep the original's result). Tests are matched by Allure id, the
 * same id that collapses retries inside one run.
 */
export interface CombinedResults {
  /** The run the chain started from. */
  rootId: string;
  /** Every finished run in the chain, oldest first. */
  runIds: string[];
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
  passRate: number | null;
  testCases: (TestCaseOutcome & { runId: string })[];
}

/** Guards against a corrupt cycle in `rerun.of`; a real chain is a handful of runs. */
const MAX_CHAIN = 200;

export async function getCombinedResults(id: string): Promise<CombinedResults> {
  // Lean: plain objects. Spreading a Mongoose subdocument copies its internals, not its fields.
  const start = await ExecutionRun.findById(id).lean<IExecutionRun>();
  if (!start) throw new NotFoundError('Execution run not found');

  // Up to the run that started the chain.
  let root: IExecutionRun = start;
  for (let i = 0; i < MAX_CHAIN && root.rerun?.of; i++) {
    const parent = await ExecutionRun.findById(root.rerun.of).lean<IExecutionRun>();
    if (!parent) break;
    root = parent;
  }

  // Then down through every rerun of a run in the chain.
  const chain: IExecutionRun[] = [root];
  let frontier: Types.ObjectId[] = [root._id];
  while (frontier.length > 0 && chain.length < MAX_CHAIN) {
    const children = await ExecutionRun.find({ 'rerun.of': { $in: frontier } }).lean<IExecutionRun[]>();
    const fresh = children.filter((c) => !chain.some((x) => String(x._id) === String(c._id)));
    chain.push(...fresh);
    frontier = fresh.map((c) => c._id);
  }

  const finished = chain
    .filter((r) => r.endedAt && r.testSummary?.testCases?.length)
    .sort((a, b) => (a.endedAt as Date).getTime() - (b.endedAt as Date).getTime());

  const byTest = new Map<string, TestCaseOutcome & { runId: string }>();
  for (const r of finished) {
    for (const tc of r.testSummary?.testCases ?? []) byTest.set(tc.id, { ...tc, runId: String(r._id) });
  }

  const testCases = [...byTest.values()];
  const count = (s: TestCaseOutcome['status']) => testCases.filter((t) => t.status === s).length;
  const passed = count('passed');
  return {
    rootId: String(root._id),
    runIds: finished.map((r) => String(r._id)),
    total: testCases.length,
    passed,
    failed: count('failed'),
    broken: count('broken'),
    skipped: count('skipped'),
    unknown: count('unknown'),
    passRate: testCases.length ? passed / testCases.length : null,
    testCases,
  };
}
