import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { dim } from '../theme.js';

export class EventLog implements Component {
  private lines: string[] = [];
  private maxLines = 20;
  private scrollOffset = 0; // 0 = bottom, positive = scrolled up by N lines
  private autoScroll = true;
  private maxBufferLines = 5000;
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;

  addLine(text: string): void {
    this.lines.push(text);
    if (this.lines.length > this.maxBufferLines) {
      this.lines = this.lines.slice(-this.maxBufferLines);
      if (this.scrollOffset > this.lines.length) {
        this.scrollOffset = this.lines.length;
      }
    }
    if (!this.autoScroll) {
      this.scrollOffset += 1;
    }
    this.invalidate();
  }

  setMaxLines(n: number): void {
    this.maxLines = n;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.lines.length - this.maxLines));
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines !== null) {
      return this.cachedLines;
    }

    const endIdx = this.lines.length - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - this.maxLines);
    let slice = this.lines.slice(startIdx, endIdx);

    // Pad to exactly maxLines lines
    while (slice.length < this.maxLines) {
      slice = ['', ...slice];
    }

    // Truncate/pad each line to exactly width
    const rendered = slice.map((line) => truncateToWidth(line, width, undefined, true));

    // If scrolled up, replace first line with scroll indicator
    if (this.isScrolledUp) {
      const indicator = dim(`↑ ${this.scrollOffset} more lines above (PgUp/PgDn)`);
      rendered[0] = truncateToWidth(indicator, width, undefined, true);
    }

    this.cachedWidth = width;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'pageUp')) {
      this.autoScroll = false;
      this.scrollOffset = Math.min(
        this.scrollOffset + Math.max(1, this.maxLines - 1),
        Math.max(0, this.lines.length - this.maxLines),
      );
    } else if (matchesKey(data, 'pageDown')) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.maxLines - 1));
      if (this.scrollOffset === 0) {
        this.autoScroll = true;
      }
    } else if (matchesKey(data, 'end')) {
      this.scrollOffset = 0;
      this.autoScroll = true;
    } else if (matchesKey(data, 'home')) {
      this.scrollOffset = Math.max(0, this.lines.length - this.maxLines);
      this.autoScroll = false;
    } else {
      return;
    }
    this.invalidate();
  }

  get totalLines(): number {
    return this.lines.length;
  }

  get isScrolledUp(): boolean {
    return this.scrollOffset > 0;
  }
}
