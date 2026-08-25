import { Schema, model, Document, Types } from 'mongoose';

export type StageName = 'pulling' | 'restoring_cache' | 'installing' | 'execute';
export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type RunStatus = 'queued' | 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled';

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
  stages: IStage[];
  workspacePath: string;
  cacheKey: string | null;
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
    stages: { type: [stageSchema], default: [] },
    workspacePath: { type: String, required: true },
    cacheKey: { type: String, default: null },
    logPath: { type: String, required: true },
    reportPath: { type: String, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ExecutionRun = model<IExecutionRun>('ExecutionRun', executionRunSchema);
