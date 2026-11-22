import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TestSummaryPanel } from './RunDetailPage';

const summary = {
  total: 3,
  passed: 1,
  failed: 1,
  broken: 1,
  skipped: 0,
  unknown: 0,
  passRate: 1 / 3,
  failures: [],
  testCases: [
    { id: 'a', name: 'logs in', status: 'passed' as const },
    { id: 'b', name: 'checks out', status: 'failed' as const, evidence: 'b-shot.png' },
    { id: 'c', name: 'opens settings', status: 'broken' as const },
  ],
};

describe('TestSummaryPanel', () => {
  it('lists failed and broken tests with the failing-step screenshot when there is one', () => {
    render(<TestSummaryPanel runId="r1" summary={summary} />);

    const shot = screen.getByRole('img', { name: 'Screen at the failing step of checks out' });
    expect(shot.getAttribute('src')).toMatch(/\/api\/execution\/r1\/evidence\/b-shot\.png$/);
    expect(screen.getByText('opens settings')).toBeInTheDocument();
    expect(screen.getByText('No screenshot')).toBeInTheDocument();
    expect(screen.queryByText('logs in')).not.toBeInTheDocument();
  });

  it('shows the total test count', () => {
    render(<TestSummaryPanel runId="r1" summary={summary} />);
    expect(screen.getByText('Tests').textContent).toContain('3');
  });
});
