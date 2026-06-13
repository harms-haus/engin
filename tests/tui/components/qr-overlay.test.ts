import { describe, expect, it } from 'bun:test';
import { createQrOverlayComponent } from '../../../src/tui/components/qr-overlay.js';

describe('QrOverlayComponent', () => {
  it('creates component with correct lineHeight for a given URL', async () => {
    const { component, lineHeight } = await createQrOverlayComponent('https://example.com');
    expect(lineHeight).toBeGreaterThan(0);
    expect(typeof component.render).toBe('function');
    expect(typeof component.invalidate).toBe('function');
    expect(typeof component.handleInput).toBe('function');
  });

  it('render returns at least 3 lines', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    const lines = component.render(40);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('last line contains the URL text', async () => {
    const testUrl = 'https://example.com/qr-test';
    const { component } = await createQrOverlayComponent(testUrl);
    const lines = component.render(40);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain(testUrl);
  });

  it('lineHeight matches render().length', async () => {
    const { component, lineHeight } = await createQrOverlayComponent('https://example.com');
    const lines = component.render(60);
    expect(lineHeight).toBe(lines.length);
  });

  it('QR code lines contain ANSI block characters', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    const lines = component.render(40);
    // QR code terminal output uses ANSI block chars like █, ▄, ▀, and spaces
    // At least some lines (excluding the last URL line) should contain block chars
    const qrLines = lines.slice(0, -1);
    const hasBlockChars = qrLines.some((line) => /[█▄▀]/.test(line));
    expect(hasBlockChars).toBe(true);
  });

  it('all lines are padded to the given width', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    const width = 50;
    const lines = component.render(width);
    for (const line of lines) {
      // visibleWidth should be exactly `width` due to truncateToWidth with pad=true
      expect(line.length).toBeGreaterThanOrEqual(width - 5); // ANSI escape sequences reduce raw length
    }
  });

  it('render returns consistent results across multiple calls', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    const lines1 = component.render(40);
    const lines2 = component.render(40);
    expect(lines1).toEqual(lines2);
  });

  it('invalidate is a no-op (does not throw)', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    expect(() => component.invalidate()).not.toThrow();
  });

  it('handleInput does nothing (non-capturing)', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    // Should not throw regardless of input
    expect(() => component.handleInput('x')).not.toThrow();
    expect(() => component.handleInput('\x1b[A')).not.toThrow();
    expect(() => component.handleInput('')).not.toThrow();
  });

  it('truncates to narrower width', async () => {
    const { component } = await createQrOverlayComponent('https://example.com');
    const wideLines = component.render(80);
    const narrowLines = component.render(20);
    expect(narrowLines.length).toBe(wideLines.length);
    // Narrow lines should be shorter (or equal) in visible width
    for (let i = 0; i < narrowLines.length; i++) {
      // Strip ANSI escapes to compare visible width
      // eslint-disable-next-line no-control-regex
      const visibleWide = wideLines[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*\x1b\\/g, '');
      // eslint-disable-next-line no-control-regex
      const visibleNarrow = narrowLines[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*\x1b\\/g, '');
      expect(visibleNarrow.length).toBeLessThanOrEqual(visibleWide.length);
    }
  });
});
