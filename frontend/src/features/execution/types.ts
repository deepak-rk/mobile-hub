export type RunStatus = 'queued' | 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface RunStage {
  name: 'pulling' | 'restoring_cache' | 'installing' | 'app_preflight' | 'execute' | 'collecting';
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
  /** Null when the project declares no variants (and on runs predating them). */
  variant?: string | null;
  /**
   * Where a failed or cancelled run stopped (backend ERROR_CLASSES, e.g.
   * test_assertion, dependency_install_failed). Null on a pass and on older runs.
   */
  errorClass?: string | null;
  suite: string;
  triggeredBy: string;
  status: RunStatus;
  /**
   * Why a `failed` run failed — mirrors FailureKind in the backend's
   * execution-run.model.ts. Only `'test'` is attributable to the application;
   * the other two are excluded from pass rate. `null` on non-failed runs and
   * on runs predating this field.
   */
  failureKind: 'test' | 'infra' | 'precondition' | null;
  /**
   * Where the run's Allure report was kept, or `null` when the runner produced
   * none. Only ever set for a report that really has an `index.html`, so the
   * UI can treat non-null as "this link works" and hide the control otherwise.
   */
  reportPath: string | null;
  /**
   * Test-case counts from the runner's Allure results, or null when it
   * produced none — which is different from a run that executed zero tests.
   */
  testSummary: {
    total: number;
    passed: number;
    failed: number;
    broken: number;
    skipped: number;
    unknown: number;
    passRate: number | null;
    /**
     * Distinct failure reasons with how many tests hit each. Twenty tests on
     * one message is one problem; twenty on twenty messages is twenty, and a
     * failed count alone cannot tell those apart.
     */
    failures: { message: string; count: number }[];
    /**
     * One entry per test. `evidence` is set on a failed or broken test that
     * has a screenshot from its failing step; absent on runs recorded before
     * evidence existed.
     */
    testCases?: {
      id: string;
      name: string;
      status: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
      evidence?: string;
    }[];
  } | null;
  stages: RunStage[];
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  /**
   * 1-based position among other runs queued for the same device, oldest
   * first — null unless `status === 'queued'`. Computed by the hub at
   * request time, not a stored fact about the run.
   */
  queuePosition: number | null;
}
