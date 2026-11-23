import { describe, it, expect, vi, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { ExecutionRun } from './execution-run.model';
import { getCombinedResults } from './combined-results';

afterEach(() => {
  vi.restoreAllMocks();
});

const id = () => new Types.ObjectId();
const tc = (testId: string, status: string) => ({ id: testId, name: testId, status });

describe('getCombinedResults', () => {
  it('takes each test from the newest run that reported it, across the whole rerun chain', async () => {
    const root = { _id: id(), rerun: null, endedAt: new Date(1000), testSummary: { testCases: [tc('a', 'passed'), tc('b', 'failed'), tc('c', 'failed')] } };
    const rerun1 = { _id: id(), rerun: { of: root._id }, endedAt: new Date(2000), testSummary: { testCases: [tc('b', 'passed'), tc('c', 'failed')] } };
    const rerun2 = { _id: id(), rerun: { of: rerun1._id }, endedAt: new Date(3000), testSummary: { testCases: [tc('c', 'broken')] } };
    const inFlight = { _id: id(), rerun: { of: rerun2._id }, endedAt: null, testSummary: null };
    const all = [root, rerun1, rerun2, inFlight];

    // Shaped like the real calls: every query ends in .lean().
    vi.spyOn(ExecutionRun, 'findById').mockImplementation(((x: unknown) => ({
      lean: () => Promise.resolve(all.find((r) => String(r._id) === String(x)) ?? null),
    })) as never);
    vi.spyOn(ExecutionRun, 'find').mockImplementation(((q: { 'rerun.of': { $in: Types.ObjectId[] } }) => ({
      lean: () =>
        Promise.resolve(
          all.filter((r) => r.rerun && q['rerun.of'].$in.some((p) => String(p) === String(r.rerun?.of))),
        ),
    })) as never);

    // Asked from the middle of the chain: same answer as from the root.
    const combined = await getCombinedResults(String(rerun1._id));
    expect(combined.rootId).toBe(String(root._id));
    expect(combined.runIds).toEqual([root, rerun1, rerun2].map((r) => String(r._id)));
    expect(Object.fromEntries(combined.testCases.map((t) => [t.id, [t.status, t.runId]]))).toEqual({
      a: ['passed', String(root._id)],
      b: ['passed', String(rerun1._id)],
      c: ['broken', String(rerun2._id)],
    });
    expect(combined).toMatchObject({ total: 3, passed: 2, broken: 1, failed: 0 });
  });

  it('404s an unknown run', async () => {
    vi.spyOn(ExecutionRun, 'findById').mockReturnValue({ lean: () => Promise.resolve(null) } as never);
    await expect(getCombinedResults(String(id()))).rejects.toMatchObject({ statusCode: 404 });
  });
});
