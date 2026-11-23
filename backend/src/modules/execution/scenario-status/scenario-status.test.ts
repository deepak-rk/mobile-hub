import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { IExecutionRun } from '../execution-run.model';
import { ExecutionRun } from '../execution-run.model';
import type { TestCaseOutcome } from '../allure-summary';
import { ScenarioState } from './scenario-state.model';
import {
  bubbleUp,
  clearStuckScenarios,
  getStatusTree,
  markRunScenarios,
  settleRunScenarios,
} from './scenario-status.service';

describe('bubbleUp', () => {
  it('follows the precedence: executing, scheduled, all-same, else partial', () => {
    expect(bubbleUp(['completed', 'executing', 'scheduled'])).toBe('executing');
    expect(bubbleUp(['completed', 'scheduled', 'failed'])).toBe('scheduled');
    expect(bubbleUp(['ready', 'ready'])).toBe('ready');
    expect(bubbleUp(['completed', 'completed'])).toBe('completed');
    expect(bubbleUp(['failed', 'failed'])).toBe('failed');
    expect(bubbleUp(['completed', 'failed'])).toBe('partial');
    expect(bubbleUp(['ready', 'completed'])).toBe('partial');
    expect(bubbleUp(['partial', 'completed'])).toBe('partial');
  });
});

/**
 * The writer rules depend on real update semantics ($slice, upserts, array
 * filters), so they run against a real MongoDB when MONGO_TEST_URI names one
 * (a throwaway database, dropped afterwards). Skipped otherwise; the rest of
 * the suite needs no database.
 */
const uri = process.env.MONGO_TEST_URI;

describe.runIf(Boolean(uri))('status board writers (MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(uri as string);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await ScenarioState.deleteMany({});
    await ExecutionRun.deleteMany({});
  });

  const tc = (id: string, status: TestCaseOutcome['status'], spec = 'test/features/a.feature'): TestCaseOutcome => ({
    id,
    name: `${spec}#A ${id}`,
    title: id,
    status,
  });

  function fakeRun(over: Partial<IExecutionRun> & { cases?: TestCaseOutcome[] }): IExecutionRun {
    return {
      _id: new Types.ObjectId(),
      project: 'p',
      variant: null,
      suite: '@all',
      snapshot: { platform: 'android' },
      rerun: null,
      status: 'failed',
      endedAt: new Date(),
      testSummary: over.cases ? { testCases: over.cases } : null,
      ...over,
    } as unknown as IExecutionRun;
  }

  const states = async () =>
    Object.fromEntries((await ScenarioState.find({}).lean()).map((d) => [d.testId, d.status]));

  it('records results: passed/skipped completed, failed/broken/unknown failed', async () => {
    await settleRunScenarios(
      fakeRun({ cases: [tc('s1', 'passed'), tc('s2', 'skipped'), tc('s3', 'failed'), tc('s4', 'broken'), tc('s5', 'unknown')] }),
    );
    expect(await states()).toEqual({ s1: 'completed', s2: 'completed', s3: 'failed', s4: 'failed', s5: 'failed' });
  });

  it('a rerun of the failed tests marks just those, and its results replace them', async () => {
    await settleRunScenarios(fakeRun({ cases: [tc('s1', 'passed'), tc('s2', 'failed')], endedAt: new Date(1000) }));
    const rerun = fakeRun({
      rerun: { of: new Types.ObjectId(), scope: 'failed', tests: ['s2'], comment: null },
      endedAt: new Date(2000),
      cases: [tc('s2', 'passed')],
    });
    await markRunScenarios(rerun, 'scheduled');
    expect(await states()).toEqual({ s1: 'completed', s2: 'scheduled' });
    await markRunScenarios(rerun, 'executing');
    expect(await states()).toEqual({ s1: 'completed', s2: 'executing' });
    await settleRunScenarios(rerun);
    expect(await states()).toEqual({ s1: 'completed', s2: 'completed' });
    const s2 = await ScenarioState.findOne({ testId: 's2' }).lean();
    expect(s2?.history.map((h) => h.status)).toEqual(['failed', 'completed']);
  });

  it('a run that ends without results fails only what it still held; a cancel puts it back to ready', async () => {
    await settleRunScenarios(fakeRun({ cases: [tc('s1', 'failed'), tc('s2', 'failed')], endedAt: new Date(1000) }));
    // Another run is executing s2 meanwhile; the failing run must not touch it.
    const other = fakeRun({ rerun: { of: new Types.ObjectId(), scope: 'failed', tests: ['s2'], comment: null } });
    await markRunScenarios(other, 'executing');
    const prepFail = fakeRun({ rerun: { of: new Types.ObjectId(), scope: 'failed', tests: ['s1'], comment: null } });
    await markRunScenarios(prepFail, 'scheduled');
    await settleRunScenarios(prepFail); // no results: checkout failed
    expect(await states()).toEqual({ s1: 'failed', s2: 'executing' });
    await settleRunScenarios(fakeRun({ ...other, cases: [tc('s2', 'failed')] } as never));

    const cancelled = fakeRun({
      status: 'cancelled',
      rerun: { of: new Types.ObjectId(), scope: 'failed', tests: ['s2'], comment: null },
    });
    await markRunScenarios(cancelled, 'executing');
    await settleRunScenarios(cancelled);
    expect(await states()).toEqual({ s1: 'failed', s2: 'ready' });
  });

  it('replaying an older run (resync) never overwrites a newer result, nor duplicates its own history', async () => {
    const older = fakeRun({ cases: [tc('s1', 'failed')], endedAt: new Date(1000) });
    const newer = fakeRun({ cases: [tc('s1', 'passed')], endedAt: new Date(2000) });
    await settleRunScenarios(older);
    await settleRunScenarios(newer);
    await settleRunScenarios(older); // resync of the older run
    expect(await states()).toEqual({ s1: 'completed' });
    await settleRunScenarios(newer); // resync of the newer run
    const s1 = await ScenarioState.findOne({ testId: 's1' }).lean();
    expect(s1?.status).toBe('completed');
    expect(s1?.history.map((h) => h.status)).toEqual(['failed', 'completed']);
  });

  it('builds the tree with bubbled-up statuses', async () => {
    await settleRunScenarios(
      fakeRun({ cases: [tc('s1', 'passed'), tc('s2', 'failed'), tc('s3', 'passed', 'test/features/b.feature')] }),
    );
    const tree = await getStatusTree('p');
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].status).toBe('partial');
    expect(tree.groups[0].features.map((f) => [f.spec, f.status])).toEqual([
      ['test/features/a.feature', 'partial'],
      ['test/features/b.feature', 'completed'],
    ]);
  });

  it('clear stuck resets nodes held by a finished run, not by a run still going', async () => {
    await settleRunScenarios(fakeRun({ cases: [tc('s1', 'failed'), tc('s2', 'failed')] }));
    const dead = await ExecutionRun.collection.insertOne({ status: 'failed' });
    const live = await ExecutionRun.collection.insertOne({ status: 'running' });
    await ScenarioState.updateOne({ testId: 's1' }, { $set: { status: 'executing', runId: dead.insertedId } });
    await ScenarioState.updateOne({ testId: 's2' }, { $set: { status: 'executing', runId: live.insertedId } });
    expect(await clearStuckScenarios('p')).toBe(1);
    expect(await states()).toEqual({ s1: 'ready', s2: 'executing' });
  });
});
