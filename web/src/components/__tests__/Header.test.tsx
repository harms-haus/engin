/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Tests for Header component.
 *
 * Verifies that the fixed-height bar renders with the logo text on the left
 * and a connection-status dot on the right.
 */

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Header } from '../Header';

describe('Header', () => {
  it('renders the header element with class "header"', () => {
    const { container } = render(<Header connected={true} />);
    const header = container.querySelector('header.header');
    expect(header).toBeInTheDocument();
  });

  it('renders the logo text "engin"', () => {
    render(<Header connected={true} />);
    expect(screen.getByText('engin')).toBeInTheDocument();
  });

  it('renders the logo with class "logo"', () => {
    const { container } = render(<Header connected={true} />);
    const logo = container.querySelector('.logo');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveTextContent('engin');
  });

  it('renders a connection status dot with class "connection-dot"', () => {
    const { container } = render(<Header connected={true} />);
    const dot = container.querySelector('.connection-dot');
    expect(dot).toBeInTheDocument();
  });

  it('applies green background (var(--engin-success)) when connected is true', () => {
    const { container } = render(<Header connected={true} />);
    const dot = container.querySelector('.connection-dot');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-success)' });
  });

  it('applies red background (var(--engin-error)) when connected is false', () => {
    const { container } = render(<Header connected={false} />);
    const dot = container.querySelector('.connection-dot');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-error)' });
  });

  it('switches dot color when connected prop changes from false to true', () => {
    const { container, rerender } = render(<Header connected={false} />);
    const dot = container.querySelector('.connection-dot')!;
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-error)' });

    rerender(<Header connected={true} />);
    expect(dot).toHaveStyle({ backgroundColor: 'var(--engin-success)' });
  });

  it('uses CSS class for dot sizing (no inline width/height/borderRadius)', () => {
    // The .connection-dot CSS class provides width, height, and border-radius via CSS.
    // The inline style should only set backgroundColor.
    const { container } = render(<Header connected={true} />);
    const dot = container.querySelector('.connection-dot') as HTMLElement;
    expect(dot.style.backgroundColor).toBeTruthy();
    expect(dot.style.width).toBe('');
    expect(dot.style.height).toBe('');
    expect(dot.style.borderRadius).toBe('');
  });
});
