import { Schema, model, Document, Types } from 'mongoose';

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
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

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
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ExecutionRun = model<IExecutionRun>('ExecutionRun', executionRunSchema);
