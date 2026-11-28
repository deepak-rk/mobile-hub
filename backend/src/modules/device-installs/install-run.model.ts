import { Schema, model, Document, Types } from 'mongoose';

/**
 * Phases of one device's install, split so each carries honest progress.
 *
 *  - `downloading`  hub -> agent HTTP transfer. Real bytes.
 *  - `transferring` agent -> device push. Real bytes, measured by polling the
 *                   file's size on the device (`adb push` prints progress only
 *                   to a TTY, so its output can't be parsed from a service).
 *  - `installing`   `pm install` on the device. Genuinely opaque — dexopt has
 *                   no byte ratio — so this phase shows a label, never a bar.
 *  - `granting-permissions` best-effort `pm grant` of each dangerous/runtime
 *                   permission the app declares — Android only, and only when
 *                   `devices.grantPermissionsOnInstall` is on (off by
 *                   default). Skipped entirely, not merely fast, when the org
 *                   hasn't opted in — see `installer.ts`.
 *
 * The split exists so the opaque part is small and clearly labelled instead of
 * swallowing the two phases that can be measured.
 */
export type InstallTargetStatus =
  | 'queued'
  | 'downloading'
  | 'transferring'
  | 'installing'
  | 'granting-permissions'
  | 'done'
  | 'error';

export interface IInstallTarget {
  deviceUdid: string;
  machineId: string;
  status: InstallTargetStatus;
  /** 0-100, download progress toward the device — installing itself is fast and not sub-divided. */
  progress: number;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /**
   * The package the agent positively identified as newly installed (diffing
   * `pm list packages` before/after — see `installer.ts`'s
   * `identifyInstalledPackage`), reported alongside `status: 'done'`. Null
   * when a same-version reinstall left the package table unchanged (nothing
   * to positively attribute) or for a run that predates this field. This is
   * what makes uninstall possible without re-deriving the package from the
   * APK on every request — it was identified once, at install time, and
   * never persisted before this.
   */
  packageName: string | null;
}

export interface IInstallRun extends Document {
  buildId: Types.ObjectId;
  project: string;
  platform: 'android' | 'ios';
  // One embedded record per targeted device — same precedent as
  // ExecutionRun.stages: independent status/progress/error per target, so
  // one device failing doesn't block or hide the others, and any single
  // target can be re-driven by triggering a fresh InstallRun against it
  // without re-touching devices that already succeeded.
  targets: IInstallTarget[];
  triggeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const installTargetSchema = new Schema<IInstallTarget>(
  {
    deviceUdid: { type: String, required: true },
    machineId: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'downloading', 'transferring', 'installing', 'granting-permissions', 'done', 'error'],
      default: 'queued',
    },
    progress: { type: Number, default: 0 },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    packageName: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Each target holds the device lock while it is in flight (sessionId and
 * reason `install:<runId>`), so an install can no longer land on a device in
 * the middle of a test run, and a run cannot start on a device mid-install.
 * Until 2026-11-28 installs deliberately took no lock; that decision was
 * reversed by the project owner. See `triggerInstallRun` for who may install
 * on a device that is already held.
 */
const installRunSchema = new Schema<IInstallRun>(
  {
    buildId: { type: Schema.Types.ObjectId, ref: 'Build', required: true, index: true },
    project: { type: String, required: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    targets: { type: [installTargetSchema], default: [] },
    triggeredBy: { type: String, required: true },
  },
  { timestamps: true },
);

export const InstallRun = model<IInstallRun>('InstallRun', installRunSchema);
