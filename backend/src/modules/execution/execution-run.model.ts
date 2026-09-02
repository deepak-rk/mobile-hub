import { Schema, model, Document, Types } from 'mongoose';
import type { TestSummary } from './allure-summary';

/**
 * The persisted shape of a test summary. Re-exported from the parser rather
 * than redeclared, so the schema and the code that fills it cannot drift.
 */
export type ITestSummary = TestSummary;

export type StageName = 'pulling' | 'restoring_cache' | 'installing' | 'execute';
export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type RunStatus = 'queued' | 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled';

/**
 * Why a `failed` run failed — orthogonal to `status`, because "the test
 * failed" and "we never got as far as running the test" are different facts
 * that were previously stored identically.
 *
 *  - `test`         the suite itself reported failure (nonzero exit from the
 *                   execute stage). The only kind attributable to the app.
 *  - `infra`        the hub's own plumbing broke — clone failed, dependency
 *                   install failed, a process wouldn't spawn, a timeout.
 *  - `precondition` the run never started at all (e.g. the device was already
 *                   locked). Nothing was executed.
 *
 * `null` on any run that is not `failed`. Analytics computes pass rate over
 * `passed` + `failed{kind:'test'}` only, so infrastructure noise cannot make a
 * healthy app look unstable.
 */
export type FailureKind = 'test' | 'infra' | 'precondition';

export interface IStage {
  name: StageName;
  status: StageStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  error: string | null;
}

export interface IExecutionRun extends Document {
  machineId: string;
  deviceUdid: string;
  buildId: Types.ObjectId | null;
  project: string;
  branch: string;
  suite: string;
  triggeredBy: string;
  status: RunStatus;
  /** Set only when `status === 'failed'`. See FailureKind. */
  failureKind: FailureKind | null;
  stages: IStage[];
  /** Ephemeral working directory — deleted when the run ends. */
  workspacePath: string;
  cacheKey: string | null;
  /** Durable per-run artifact directory; survives workspace cleanup. */
  artifactsPath: string;
  logPath: string;
  reportPath: string | null;
  /**
   * Test-case-level counts parsed from the runner's Allure results, or null
   * when it produced none.
   *
   * Distinct from `status`, which is run-level: a run where 143 of 145 tests
   * passed is failed at run level and 98.6% here. Null rather than zeros so
   * "no Allure output" stays distinguishable from "ran zero tests" — the
   * first is a project not using Allure, the second is a real result.
   */
  testSummary: ITestSummary | null;
  /**
   * Facts about this run frozen at the moment it was triggered.
   *
   * Analytics used to join a run's platform from the *current* `Device`
   * record, so removing a device retroactively rewrote history — a
   * six-month-old Android run silently became unattributed. History is a
   * statement about what happened, and it cannot depend on what is still
   * connected today.
   *
   * Every field is nullable, and runs predating this have the whole block
   * null. Back-filling a value that was never recorded would be a guess
   * dressed as a fact, so analytics falls back to the old live join for those
   * and uses the snapshot for everything since.
   */
  snapshot: IRunSnapshot | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `suiteKind` records how the operator addressed the suite, because a
 * Cucumber tag and a feature path are genuinely different selections that can
 * cover overlapping tests. Storing which one it was is what stops analytics
 * from silently comparing them as if they were the same suite.
 */
export interface IRunSnapshot {
  platform: 'android' | 'ios' | null;
  deviceModel: string | null;
  deviceName: string | null;
  framework: string | null;
  suiteKind: 'tag' | 'feature' | 'name' | null;
  /** Resolved after `pulling`; null when no repo was cloned. */
  commit: string | null;
}

const runSnapshotSchema = new Schema<IRunSnapshot>(
  {
    platform: { type: String, enum: ['android', 'ios'], default: null },
    deviceModel: { type: String, default: null },
    deviceName: { type: String, default: null },
    framework: { type: String, default: null },
    suiteKind: { type: String, enum: ['tag', 'feature', 'name'], default: null },
    commit: { type: String, default: null },
  },
  { _id: false },
);

const testSummarySchema = new Schema<ITestSummary>(
  {
    total: { type: Number, required: true },
    passed: { type: Number, required: true },
    failed: { type: Number, required: true },
    broken: { type: Number, required: true },
    skipped: { type: Number, required: true },
    unknown: { type: Number, required: true },
    passRate: { type: Number, default: null },
    // Bounded and denormalised on purpose: written once when the run ends and
    // only ever read back with the run, so a separate collection would buy
    // nothing but a join.
    failures: {
      type: [new Schema({ message: String, count: Number }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

const stageSchema = new Schema<IStage>(
  {
    name: { type: String, enum: ['pulling', 'restoring_cache', 'installing', 'execute'], required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'error', 'skipped'], default: 'pending' },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const executionRunSchema = new Schema<IExecutionRun>(
  {
    machineId: { type: String, required: true, index: true },
    deviceUdid: { type: String, required: true, index: true },
    buildId: { type: Schema.Types.ObjectId, ref: 'Build', default: null },
    project: { type: String, required: true, index: true },
    branch: { type: String, required: true },
    suite: { type: String, required: true },
    triggeredBy: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'preparing', 'running', 'passed', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    failureKind: { type: String, enum: ['test', 'infra', 'precondition'], default: null },
    stages: { type: [stageSchema], default: [] },
    workspacePath: { type: String, required: true },
    cacheKey: { type: String, default: null },
    // Not `required` — runs created before durable artifacts existed have no
    // value, and back-filling a path that was never written would be a lie.
    artifactsPath: { type: String, default: '' },
    logPath: { type: String, required: true },
    reportPath: { type: String, default: null },
    // Embedded rather than a separate collection: it is written once when the
    // run ends, read with the run, and never queried on its own.
    testSummary: { type: testSummarySchema, default: null },
    snapshot: { type: runSnapshotSchema, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ExecutionRun = model<IExecutionRun>('ExecutionRun', executionRunSchema);
