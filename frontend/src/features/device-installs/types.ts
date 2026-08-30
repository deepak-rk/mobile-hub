export interface InstallTarget {
  deviceUdid: string;
  machineId: string;
  status: 'queued' | 'downloading' | 'installing' | 'done' | 'error';
  progress: number;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface InstallRun {
  _id: string;
  buildId: string;
  project: string;
  platform: 'android' | 'ios';
  targets: InstallTarget[];
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
}
