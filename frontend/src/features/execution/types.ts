export type RunStatus = 'queued' | 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface RunStage {
  name: 'pulling' | 'restoring_cache' | 'installing' | 'execute';
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface ExecutionRun {
  _id: string;
  machineId: string;
  deviceUdid: string;
  project: string;
  branch: string;
  suite: string;
  triggeredBy: string;
  status: RunStatus;
  stages: RunStage[];
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}
