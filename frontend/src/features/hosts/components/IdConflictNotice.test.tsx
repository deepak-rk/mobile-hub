import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IdConflictNotice } from './IdConflictNotice';

describe('IdConflictNotice', () => {
  it('renders nothing without a conflict', () => {
    const { container } = render(<IdConflictNotice conflict={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the refused machine when the hub knows it', () => {
    render(<IdConflictNotice conflict={{ at: new Date().toISOString(), hostname: 'box-2' }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/'box-2' tried to join with this machine id/);
  });

  it('falls back to a generic name', () => {
    render(<IdConflictNotice conflict={{ at: new Date().toISOString(), hostname: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Another machine tried/);
  });
});
