import { Types } from 'mongoose';
import type { IExecutionRun } from '../execution-run.model';
import { ExecutionRun } from '../execution-run.model';
import { classifySuite } from '../automation-commands';
import type { TestCaseOutcome } from '../allure-summary';
import { HISTORY_CAP, IScenarioState, ScenarioState, ScenarioStatus } from './scenario-state.model';

/**
 * The writers of the status board, and the rules each one keeps. A reference
 * farm in this domain arrived at these after its board showed wrong states:
 *
 *  - `markRunScenarios` — at schedule, at execute start, and when a run ends
 *    without results (a prep failure or a cancel). A failure marks only the
 *    nodes this run itself still has scheduled or executing, so it never
 *    overwrites a result this run already produced.
 *  - `updateFromResults` — at run end, from the run's collapsed results
 *    (retries already reduced to the newest attempt): passed/skipped →
 *    completed, failed/broken/unknown → failed, and anything this run left
 *    scheduled or executing → failed.
 *  - resync and restart recovery replay `updateFromResults`; `resultAt` keeps
 *    an older run's results from overwriting a newer run's.
 *
 * `applyLiveResults` — while the run executes, each result as the runner
 *    writes it (`live-results.ts`). Never final: it marks what finished and
 *    nothing else, and leaves "what did this run not reach" to
 *    `updateFromResults`. A run selected by tag or named suite marks nothing
 *    at schedule (which scenarios it holds is unknown until they report).
 */

type Group = { project: string; platform: string; variant: string };

function groupOf(run: IExecutionRun): Group | null {
  const platform = run.snapshot?.platform;
  if (!platform) return null;
  return { project: run.project, platform, variant: run.variant ?? '' };
}

/** `<feature path>#<feature> <scenario>`, as WebdriverIO's Allure reporter writes it. */
function specOf(tc: TestCaseOutcome): string {
  const i = tc.name.indexOf('#');
  return i > 0 ? tc.name.slice(0, i) : '(no feature file)';
}

/** Which board nodes a run is known, before it has results, to be running. */
function selectionFilter(run: IExecutionRun): Record<string, unknown> | null {
  if (run.rerun?.scope === 'failed') return { testId: { $in: run.rerun.tests } };
  if (run.suite && classifySuite(run.suite) === 'feature') return { spec: run.suite };
  return null;
}

export async function markRunScenarios(run: IExecutionRun, status: 'scheduled' | 'executing'): Promise<number> {
  const group = groupOf(run);
  const selection = selectionFilter(run);
  if (!group || !selection) return 0;
  const res = await ScenarioState.updateMany({ ...group, ...selection }, { $set: { status, runId: run._id } });
  return res.modifiedCount;
}

/**
 * A run ended without results: what it still holds goes to `failed` (it
 * failed before reaching them) or back to `ready` (it was cancelled, so they
 * were never tried). Only this run's own scheduled/executing nodes.
 */
async function releaseRunScenarios(run: IExecutionRun, status: 'failed' | 'ready'): Promise<number> {
  const group = groupOf(run);
  if (!group) return 0;
  const update: Record<string, unknown> = { $set: { status } };
  if (status === 'failed') {
    update.$push = { history: { $each: [{ runId: run._id, status, at: new Date() }], $slice: -HISTORY_CAP } };
  }
  const res = await ScenarioState.updateMany(
    { ...group, runId: run._id, status: { $in: ['scheduled', 'executing'] } },
    update,
  );
  return res.modifiedCount;
}

function resultStatus(tc: TestCaseOutcome): ScenarioStatus {
  return tc.status === 'passed' || tc.status === 'skipped' ? 'completed' : 'failed';
}

export async function updateFromResults(run: IExecutionRun): Promise<number> {
  const written = await writeResults(run, run.testSummary?.testCases ?? [], run.endedAt ?? new Date());
  // A part-read summary says nothing about the tests it did not read: what
  // this run still holds goes back to ready, not to failed.
  await releaseRunScenarios(run, run.testSummary?.truncated ? 'ready' : 'failed');
  return written;
}

/** Results seen while the run is still going. Marks only these; releases nothing. */
export async function applyLiveResults(run: IExecutionRun, cases: TestCaseOutcome[]): Promise<number> {
  return writeResults(run, cases, new Date());
}

async function writeResults(run: IExecutionRun, cases: TestCaseOutcome[], at: Date): Promise<number> {
  const group = groupOf(run);
  if (!group || cases.length === 0) return 0;

  const existing = new Map(
    (await ScenarioState.find({ ...group, testId: { $in: cases.map((c) => c.id) } })).map((d) => [d.testId, d]),
  );
  const writes = [];
  for (const tc of cases) {
    const status = resultStatus(tc);
    const node = existing.get(tc.id);
    const fields = { spec: specOf(tc), title: tc.title ?? tc.name, status, runId: run._id, resultAt: at };
    const history = { $each: [{ runId: run._id, status, at }], $slice: -HISTORY_CAP };
    if (!node) {
      writes.push({
        updateOne: {
          filter: { ...group, testId: tc.id },
          update: { $setOnInsert: { ...group, testId: tc.id }, $set: fields, $push: { history } },
          upsert: true,
        },
      });
    } else if (isNotNewer(node, run._id, at)) {
      // A later write for the same run (the final result after a live one, or
      // a resync) rewrites its own history entry rather than adding a second.
      const ownEntry = node.history.some((h) => h.runId.equals(run._id));
      writes.push({
        updateOne: ownEntry
          ? {
              filter: { _id: node._id },
              update: { $set: { ...fields, 'history.$[own].status': status, 'history.$[own].at': at } },
              arrayFilters: [{ 'own.runId': run._id }],
            }
          : { filter: { _id: node._id }, update: { $set: fields, $push: { history } } },
      });
    }
  }
  if (writes.length > 0) await ScenarioState.bulkWrite(writes);
  return writes.length;
}

/** True when `node` holds nothing newer than this run's result. */
function isNotNewer(node: IScenarioState, runId: Types.ObjectId, at: Date): boolean {
  if (node.runId.equals(runId)) return true;
  // Scheduled/executing by another run, which is still going: its result is coming.
  if (node.status === 'scheduled' || node.status === 'executing') return false;
  return !node.resultAt || node.resultAt.getTime() <= at.getTime();
}

/** Called once a run has its final status and `endedAt`. */
export async function settleRunScenarios(run: IExecutionRun): Promise<void> {
  if (run.testSummary?.testCases?.length) await updateFromResults(run);
  else await releaseRunScenarios(run, run.status === 'cancelled' ? 'ready' : 'failed');
}

export type TreeStatus = ScenarioStatus | 'partial';

/**
 * A parent's status from its children: running → executing ·
 * scheduled → scheduled · all ready → ready · all completed → completed ·
 * all failed → failed · otherwise partial.
 */
export function bubbleUp(children: TreeStatus[]): TreeStatus {
  if (children.length === 0) return 'ready';
  if (children.includes('executing')) return 'executing';
  if (children.includes('scheduled')) return 'scheduled';
  for (const s of ['ready', 'completed', 'failed'] as const) {
    if (children.every((c) => c === s)) return s;
  }
  return 'partial';
}

export interface StatusTree {
  groups: {
    platform: string;
    variant: string | null;
    status: TreeStatus;
    features: {
      spec: string;
      status: TreeStatus;
      scenarios: {
        testId: string;
        title: string;
        status: ScenarioStatus;
        runId: string;
        updatedAt: Date;
        history: { runId: string; status: ScenarioStatus; at: Date }[];
      }[];
    }[];
  }[];
}

export async function getStatusTree(project: string): Promise<StatusTree> {
  const nodes = await ScenarioState.find({ project }).sort({ platform: 1, variant: 1, spec: 1, title: 1 }).lean();
  // Maps, not array scans: a reference farm's tree build was quadratic in
  // scenarios and hung its browser on a large suite.
  const groups = new Map<string, StatusTree['groups'][number]>();
  const features = new Map<string, StatusTree['groups'][number]['features'][number]>();
  for (const n of nodes) {
    const gk = `${n.platform}\u0000${n.variant}`;
    let g = groups.get(gk);
    if (!g) {
      g = { platform: n.platform, variant: n.variant || null, status: 'ready', features: [] };
      groups.set(gk, g);
    }
    const fk = `${gk}\u0000${n.spec}`;
    let f = features.get(fk);
    if (!f) {
      f = { spec: n.spec, status: 'ready', scenarios: [] };
      features.set(fk, f);
      g.features.push(f);
    }
    f.scenarios.push({
      testId: n.testId,
      title: n.title,
      status: n.status,
      runId: String(n.runId),
      updatedAt: n.updatedAt,
      history: n.history.map((h) => ({ runId: String(h.runId), status: h.status, at: h.at })),
    });
  }
  for (const g of groups.values()) {
    for (const f of g.features) f.status = bubbleUp(f.scenarios.map((s) => s.status));
    g.status = bubbleUp(g.features.map((f) => f.status));
  }
  return { groups: [...groups.values()] };
}

/**
 * "Clear stuck": nodes left scheduled or executing by a run that is no longer
 * in flight go back to ready. Nodes of a run still going are left alone.
 */
export async function clearStuckScenarios(project: string): Promise<number> {
  const held = await ScenarioState.find({ project, status: { $in: ['scheduled', 'executing'] } }).select('runId');
  if (held.length === 0) return 0;
  const runIds = [...new Set(held.map((h) => String(h.runId)))];
  const live = await ExecutionRun.find({
    _id: { $in: runIds },
    status: { $in: ['queued', 'preparing', 'running'] },
  }).select('_id');
  const liveIds = live.map((r) => r._id);
  const res = await ScenarioState.updateMany(
    { project, status: { $in: ['scheduled', 'executing'] }, runId: { $nin: liveIds } },
    { $set: { status: 'ready' } },
  );
  return res.modifiedCount;
}
