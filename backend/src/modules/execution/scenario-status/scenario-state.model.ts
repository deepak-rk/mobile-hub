import { Schema, model, Document, Types } from 'mongoose';

/**
 * The status board: the latest known state of every scenario, per execution
 * group (project × platform × variant).
 *
 * Runs are history; this is "where does each test stand right now". A
 * scenario's identity is its Allure id (stable across runs and reruns, see
 * `keyOf` in allure-summary.ts); `spec` and `title` place it in the tree and
 * are what a rerun selects by.
 */
export type ScenarioStatus = 'ready' | 'scheduled' | 'executing' | 'completed' | 'failed';
export const SCENARIO_STATUSES: ScenarioStatus[] = ['ready', 'scheduled', 'executing', 'completed', 'failed'];

export interface IScenarioHistoryEntry {
  runId: Types.ObjectId;
  status: ScenarioStatus;
  at: Date;
}

export interface IScenarioState extends Document {
  project: string;
  platform: string;
  /** '' when the project has no variants: a unique index cannot treat null as one value reliably. */
  variant: string;
  testId: string;
  spec: string;
  title: string;
  status: ScenarioStatus;
  /** The run that last wrote this node. */
  runId: Types.ObjectId;
  /**
   * When the result behind `status` was produced (the run's end), so an older
   * run's results, replayed by resync, never overwrite a newer run's.
   */
  resultAt: Date | null;
  /** Newest last, capped (`HISTORY_CAP`). */
  history: IScenarioHistoryEntry[];
  updatedAt: Date;
  createdAt: Date;
}

export const HISTORY_CAP = 20;

const scenarioStateSchema = new Schema<IScenarioState>(
  {
    project: { type: String, required: true },
    platform: { type: String, required: true },
    variant: { type: String, default: '' },
    testId: { type: String, required: true },
    spec: { type: String, required: true },
    title: { type: String, required: true },
    status: { type: String, enum: SCENARIO_STATUSES, required: true },
    runId: { type: Schema.Types.ObjectId, ref: 'ExecutionRun', required: true, index: true },
    resultAt: { type: Date, default: null },
    history: {
      type: [
        new Schema<IScenarioHistoryEntry>(
          {
            runId: { type: Schema.Types.ObjectId, ref: 'ExecutionRun', required: true },
            status: { type: String, enum: SCENARIO_STATUSES, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

scenarioStateSchema.index({ project: 1, platform: 1, variant: 1, testId: 1 }, { unique: true });

export const ScenarioState = model<IScenarioState>('ScenarioState', scenarioStateSchema);
