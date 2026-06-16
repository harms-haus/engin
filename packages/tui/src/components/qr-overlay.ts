import { type Component, truncateToWidth } from '@earendil-works/pi-tui';
import QRCode from 'qrcode';

export async function createQrOverlayComponent(url: string): Promise<{ component: Component; lineHeight: number }> {
  const qrString = await QRCode.toString(url, { type: 'terminal', small: true });
  const qrLines = qrString.split('\n');

  const urlLine = '\x1b]8;;' + url + '\x1b\\' + url + '\x1b]8;;\x1b\\';

  const component: Component = {
    render(width: number): string[] {
      const lines: string[] = [];
      for (const line of qrLines) {
        lines.push(truncateToWidth(line, width, undefined, true));
      }
      lines.push(truncateToWidth(urlLine, width, undefined, true));
      return lines;
    },
    invalidate(): void {
      // no-op
    },
    handleInput(_data: string): void {
      // non-capturing overlay — ignore input
    },
  };

  return { component, lineHeight: qrLines.length + 1 };
}
