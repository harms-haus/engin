/**
 * QrOverlay — Ink-based QR code overlay component.
 *
 * Renders a QR code (via `qrcode` package) in an overlay anchored to the
 * top-right of the terminal, using `<Layer>` from `@harms-haus/ink-overlay`.
 *
 * ## Exports
 *
 * - `QrOverlay` — React component with props `{ open, qrString }`.
 * - `generateQrString(url)` — async helper that produces the annotated QR
 *   string (QR code + OSC-8 hyperlink footer).
 */

import { Layer } from '@harms-haus/ink-overlay';
import { Box, Text } from 'ink';
import QRCode from 'qrcode';
import { type ReactNode } from 'react';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface QrOverlayProps {
  /** Whether the overlay is visible. */
  open: boolean;
  /** Pre-generated QR string (output of `generateQrString`), or null/empty to hide. */
  qrString: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * QR-code overlay component.
 *
 * Displays a QR code (rendered from a pre-generated string) in a non-capturing
 * top-right overlay. When `open` is false or `qrString` is null/empty, renders
 * nothing.
 *
 * The `qrString` is expected to contain QR block-char lines separated by `\n`,
 * optionally followed by an OSC-8 hyperlink footer line.
 */
export function QrOverlay({ open, qrString }: QrOverlayProps): ReactNode {
  if (!open || !qrString) {
    return null;
  }

  const lines = qrString.split('\n');

  return (
    <Layer anchor="top-right" capture={false} backdrop="none" margin={{ top: 1, right: 1 }} open={open}>
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      </Box>
    </Layer>
  );
}

// ─── Async helper ────────────────────────────────────────────────────────────

/**
 * Generate a QR-code string for the given URL.
 *
 * Uses `qrcode.toString(url, { type: 'terminal', small: true })` to produce
 * the QR matrix as ANSI block characters, then appends an OSC-8 hyperlink
 * line containing the URL.
 *
 * @param url - The URL to encode.
 * @returns A multi-line string: QR code block characters followed by the URL
 *   with OSC-8 hyperlink annotation.
 */
export async function generateQrString(url: string): Promise<string> {
  const qrCode = await QRCode.toString(url, { type: 'terminal', small: true });
  const urlLine = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
  return `${qrCode}\n${urlLine}`;
}
