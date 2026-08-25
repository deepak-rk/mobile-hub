export interface Build {
  _id: string;
  project: string;
  platform: 'android' | 'ios';
  version: string;
  artifactUrl: string;
  sizeBytes: number | null;
  checksum: string | null;
  status: 'downloading' | 'validating' | 'corrupt' | 'ready';
  integrityValidatedAt: string | null;
  fetchedAt: string | null;
  createdAt: string;
}
