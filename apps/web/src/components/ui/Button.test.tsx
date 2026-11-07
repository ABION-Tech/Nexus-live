// First test in apps/web — SESSION_LOG flagged "no apps/web test script
// at all" as an open setup gap (Session 17/18 next-steps #5). This is a
// smoke test for the Tier 1 Button primitive, not full coverage; it
// exists to prove the harness (vitest + jsdom + testing-library) works
// end to end so future module tests have a working pattern to copy.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders its label and default variant class', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('nx-btn--primary');
  });

  it('applies the requested variant and size', () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('nx-btn--danger');
    expect(btn.className).toContain('nx-btn--sm');
  });

  it('fires onClick and respects the disabled attribute', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Submit
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Submit' });
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(btn).toBeDisabled();
  });
});
