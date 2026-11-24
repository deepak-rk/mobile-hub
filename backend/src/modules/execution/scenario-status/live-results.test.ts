import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLiveResultsReader } from './live-results';

describe('createLiveResultsReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-results-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (file: string, body: object | string) =>
    fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  const result = (historyId: string, status: string, stop: number) => ({
    historyId,
    name: historyId,
    fullName: `f.feature#F ${historyId}`,
    status,
    stop,
  });

  it('returns nothing before the runner has created the folder', () => {
    expect(createLiveResultsReader([path.join(dir, 'missing')]).poll()).toEqual([]);
  });

  it('reports each result once, as it appears, and only changes after that', () => {
    const reader = createLiveResultsReader([path.join(dir, 'missing'), dir]);
    write('a-result.json', result('t1', 'passed', 10));
    write('a-container.json', { children: [] });
    expect(reader.poll().map((o) => [o.id, o.status])).toEqual([['t1', 'passed']]);
    expect(reader.poll()).toEqual([]);
    write('b-result.json', result('t2', 'failed', 20));
    expect(reader.poll().map((o) => o.id)).toEqual(['t2']);
  });

  it('a retry replaces the earlier attempt; an older attempt read late does not', () => {
    const reader = createLiveResultsReader([dir]);
    write('a-result.json', result('t1', 'failed', 10));
    expect(reader.poll().map((o) => o.status)).toEqual(['failed']);
    write('b-result.json', result('t1', 'passed', 20));
    expect(reader.poll().map((o) => o.status)).toEqual(['passed']);
    write('c-result.json', result('t1', 'failed', 5));
    expect(reader.poll()).toEqual([]);
  });

  it('retries a half-written file on the next poll instead of dropping it', () => {
    const reader = createLiveResultsReader([dir]);
    write('a-result.json', '{"historyId": "t1", "sta');
    expect(reader.poll()).toEqual([]);
    write('a-result.json', result('t1', 'passed', 10));
    expect(reader.poll().map((o) => o.id)).toEqual(['t1']);
  });

  it('parses at most maxPerPoll new files per poll and leaves the rest for the next', () => {
    const reader = createLiveResultsReader([dir], 2);
    for (const id of ['t1', 't2', 't3']) write(`${id}-result.json`, result(id, 'passed', 1));
    expect(reader.poll()).toHaveLength(2);
    expect(reader.poll()).toHaveLength(1);
    expect(reader.poll()).toHaveLength(0);
  });
});
