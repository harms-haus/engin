/**
 * Tests for QrOverlay (Ink-based component) and generateQrString.
 *
 * Covers:
 *   - Rendering QR lines when open with block chars
 *   - Rendering nothing when closed
 *   - Rendering nothing when qrString is null/empty
 *   - generateQrString produces block chars and URL
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { renderWithHost } from '../test-harness.js';
import { QrOverlay, generateQrString } from './qr-overlay.js';

// ─── Sample QR data ──────────────────────────────────────────────────────────

/** A known QR-code string (block chars + URL line) for a test URL. */
const SAMPLE_URL = 'https://example.com/qr-test';

// We generate a real QR string once for the component tests that need it.
// Using a longer timeout since QR generation may be async.
let sampleQrString: string;

beforeAll(async () => {
  sampleQrString = await generateQrString(SAMPLE_URL);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('QrOverlay (React/Ink)', () => {
  /** Microtask boundary so React / Ink flush pending updates. */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  describe('rendering', () => {
    it('renders QR block chars when open and qrString is provided', async () => {
      const result = renderWithHost(<QrOverlay open={true} qrString={sampleQrString} />);

      // Layer registers content via useEffect, which triggers a re-render.
      // Two ticks: one to flush the effect, another for the re-render.
      await tick();
      await tick();

      const frame = result.lastFrame();
      expect(frame).toBeTruthy();

      // The frame should contain the URL text
      expect(frame).toContain(SAMPLE_URL);

      // The frame should contain QR block characters (█ ▄ ▀)
      expect(frame).toMatch(/[█▄▀]/);

      result.unmount();
    });

    it('renders nothing when open is false', () => {
      const { lastFrame, unmount } = renderWithHost(<QrOverlay open={false} qrString={sampleQrString} />);

      const frame = lastFrame();
      // When closed, the Layer is not rendered, so output should be empty
      expect(frame?.trim() ?? '').toBe('');

      unmount();
    });

    it('renders nothing when qrString is null', () => {
      const { lastFrame, unmount } = renderWithHost(<QrOverlay open={true} qrString={null} />);

      const frame = lastFrame();
      expect(frame?.trim() ?? '').toBe('');

      unmount();
    });

    it('renders nothing when qrString is empty string', () => {
      const { lastFrame, unmount } = renderWithHost(<QrOverlay open={true} qrString="" />);

      const frame = lastFrame();
      expect(frame?.trim() ?? '').toBe('');

      unmount();
    });

    it('renders each QR line as a separate text element', async () => {
      const multiLineQr = '██\n▀▀\n  \n' + SAMPLE_URL;
      const result = renderWithHost(<QrOverlay open={true} qrString={multiLineQr} />);

      // Wait for effects + re-render
      await tick();
      await tick();

      const frame = result.lastFrame();
      expect(frame).toBeTruthy();

      // The frame should contain the URL text
      expect(frame).toContain(SAMPLE_URL);

      // The frame should contain the block chars from the multi-line string
      expect(frame).toContain('██');
      expect(frame).toContain('▀▀');

      result.unmount();
    });
  });

  describe('generateQrString', () => {
    it('returns a string containing QR block characters', async () => {
      const result = await generateQrString('https://example.com');
      expect(result).toBeTruthy();
      // QR code terminal output uses ANSI block chars
      expect(result).toMatch(/[█▄▀]/);
    });

    it('returns a string containing the URL', async () => {
      const url = 'https://example.com/unique-test-path';
      const result = await generateQrString(url);
      expect(result).toContain(url);
    });

    it('returns multiple lines (QR code + URL line)', async () => {
      const result = await generateQrString('https://example.com');
      const lines = result.split('\n');
      // At minimum: some QR lines + 1 URL line
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it('last line is an OSC-8 hyperlink with the URL', async () => {
      const url = 'https://example.com/osc8-test';
      const result = await generateQrString(url);
      const lines = result.split('\n');
      const lastLine = lines[lines.length - 1];

      // The last line should contain the OSC-8 escape sequences
      expect(lastLine).toContain('\x1b]8;;');
      expect(lastLine).toContain(url);
      expect(lastLine).toContain('\x1b\\');
    });

    it('different URLs produce different QR strings', async () => {
      const result1 = await generateQrString('https://example.com/a');
      const result2 = await generateQrString('https://example.com/b');
      // Different URLs encode to different QR patterns
      expect(result1).not.toEqual(result2);
    });
  });
});
