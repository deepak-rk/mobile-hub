import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Types } from 'mongoose';
import { buildApp } from '../../app';
import { PLATFORM_DEFAULTS } from '../../config/org-config.schema';
import { ExecutionRun } from './execution-run.model';
import { ALLURE_RESULTS_DIRNAME, failureEvidenceOf, summarizeAllureResults } from './allure-summary';

// See content-security-policy.test.ts: the wrapped import() fails under Vitest.
vi.mock('../../common/dynamic-import', () => ({
  default: (specifier: string) => import(specifier),
}));

const img = (source: string) => ({ name: 'Screenshot', source, type: 'image/png' });

describe('failureEvidenceOf', () => {
  it('takes the image of the failing step, not the first image of the test', () => {
    const result = {
      status: 'failed',
      steps: [
        { status: 'passed', attachments: [img('a-before.png')] },
        {
          status: 'failed',
          steps: [
            { status: 'passed', attachments: [img('b-inner-ok.png')] },
            { status: 'failed', attachments: [{ source: 'log.txt', type: 'text/plain' }, img('c-at-failure.png')] },
          ],
        },
        { status: 'skipped', attachments: [img('d-after.png')] },
      ],
    };
    expect(failureEvidenceOf(result)).toBe('c-at-failure.png');
  });

  it('falls back to the last test-level image (an after-test hook) when the step has none', () => {
    const result = {
      status: 'broken',
      steps: [{ status: 'passed', attachments: [img('ok.png')] }, { status: 'broken' }],
      attachments: [img('early.png'), img('on-failure.png')],
    };
    expect(failureEvidenceOf(result)).toBe('on-failure.png');
  });

  it('never uses a passed step image, and ignores unsafe names', () => {
    expect(failureEvidenceOf({ status: 'failed', steps: [{ status: 'passed', attachments: [img('ok.png')] }] })).toBeNull();
    expect(failureEvidenceOf({ status: 'failed', attachments: [img('../escape.png')] })).toBeNull();
  });

  it('is recorded on failed test cases only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-evidence-'));
    try {
      const write = (id: string, body: object) =>
        fs.writeFileSync(path.join(dir, `${id}-result.json`), JSON.stringify({ name: id, historyId: id, ...body }));
      write('t1', { status: 'failed', attachments: [img('t1.png')] });
      write('t2', { status: 'passed', attachments: [img('t2.png')] });
      const cases = summarizeAllureResults(dir)!.testCases;
      expect(cases.find((c) => c.id === 't1')?.evidence).toBe('t1.png');
      expect(cases.find((c) => c.id === 't2')).not.toHaveProperty('evidence');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/execution/:id/evidence/:file', () => {
  let app: FastifyInstance;
  let artifacts: string;

  beforeAll(async () => {
    artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-evidence-run-'));
    const results = path.join(artifacts, ALLURE_RESULTS_DIRNAME);
    fs.mkdirSync(results);
    fs.writeFileSync(path.join(results, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(results, 'other.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue({
      artifactsPath: artifacts,
      testSummary: { testCases: [{ id: 't', name: 't', status: 'failed', evidence: 'shot.png' }] },
    } as never);
    app = await buildApp(PLATFORM_DEFAULTS);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(artifacts, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const get = (file: string) =>
    app.inject({ method: 'GET', url: `/api/execution/${new Types.ObjectId().toString()}/evidence/${file}` });

  it('serves the screenshot the summary names', async () => {
    const res = await get('shot.png');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('refuses a file in the results that is not named as evidence', async () => {
    expect((await get('other.png')).statusCode).toBe(404);
    expect((await get('..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
  });
});
