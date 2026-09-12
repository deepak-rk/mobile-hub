import { Schema, model, Document } from 'mongoose';

/**
 * Mirrors InstallTargetStatus's shape (queued -> in-flight -> terminal), but
 * uninstall has only one real phase on the device — no download/transfer to
 * sub-divide, since `pm uninstall` takes nothing but the package name.
 */
export type UninstallTargetStatus = 'queued' | 'uninstalling' | 'done' | 'error';

export interface IUninstallTarget {
  deviceUdid: string;
  machineId: string;
  status: UninstallTargetStatus;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

/**
 * A device-app operation, not a one-off UI call — same embedded-targets
 * precedent as InstallRun/ExecutionRun.stages, so one device failing to
 * uninstall neither blocks nor hides the others, and history survives the
 * action. `packageName` is a plain string, not a `Build` reference: the
 * whole point of uninstall is that it still works after the build that put
 * the package there has been purged or the record itself deleted — the
 * device doesn't know or care where its app came from.
 */
export interface IUninstallRun extends Document {
  packageName: string;
  /** Carried for filtering/display only — see the doc comment above for why this isn't a Build reference. */
  project: string;
  targets: IUninstallTarget[];
  triggeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const uninstallTargetSchema = new Schema<IUninstallTarget>(
  {
    deviceUdid: { type: String, required: true },
    machineId: { type: String, required: true },
    status: { type: String, enum: ['queued', 'uninstalling', 'done', 'error'], default: 'queued' },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * No device lock held while a target is in flight, for the same reason
 * InstallRun holds none (install-run.model.ts's doc comment) — the accepted
 * tradeoff stands symmetrically for the operation that reverses it.
 */
const uninstallRunSchema = new Schema<IUninstallRun>(
  {
    packageName: { type: String, required: true },
    project: { type: String, required: true, index: true },
    targets: { type: [uninstallTargetSchema], default: [] },
    triggeredBy: { type: String, required: true },
  },
  { timestamps: true },
);

export const UninstallRun = model<IUninstallRun>('UninstallRun', uninstallRunSchema);
