export interface Host {
  _id: string;
  machineId: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  agentVersion: string;
  capabilities: {
    maxDevices: number;
    androidSupport: boolean;
    iosSupport: boolean;
  };
  status: 'online' | 'offline';
  lastHeartbeatAt: string;
}
