import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { dim } from '../theme.js';

export class EventLog implements Component {
  private buf: string[];
  private head = 0;
  private len = 0;
  private maxLines: number;
  private maxBufferLines: number;
  private scrollOffset = 0; // 0 = bottom, positive = scrolled up by N lines
  private autoScroll = true;
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;

  constructor(maxLines = 20, maxBufferLines = 5000) {
    this.maxLines = maxLines;
    this.maxBufferLines = maxBufferLines;
    this.buf = new Array<string>(maxBufferLines);
  }

  addLine(text: string): void {
    this.buf[this.head] = text;
    this.head = (this.head + 1) % this.maxBufferLines;
    if (this.len < this.maxBufferLines) this.len++;
    if (!this.autoScroll) {
      this.scrollOffset += 1;
    }
    this.invalidate();
  }

  get lines(): string[] {
    if (this.len < this.maxBufferLines) {
      return this.buf.slice(0, this.len);
    }
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  setMaxLines(n: number): void {
    this.maxLines = n;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.len - this.maxLines));
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines !== null) {
      return this.cachedLines;
    }

    const totalLines = this.len;
    const endIdx = totalLines - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - this.maxLines);
    const startPhysical = this.len < this.maxBufferLines ? 0 : this.head;

    const rendered: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      const physIdx = (startPhysical + i) % this.maxBufferLines;
      rendered.push(truncateToWidth(this.buf[physIdx], width, undefined, true));
    }

    // Pad to exactly maxLines lines
    while (rendered.length < this.maxLines) {
      rendered.unshift(truncateToWidth('', width, undefined, true));
    }

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
        Math.max(0, this.len - this.maxLines),
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
      this.scrollOffset = Math.max(0, this.len - this.maxLines);
      this.autoScroll = false;
    } else {
      return;
    }
    this.invalidate();
  }

  get totalLines(): number {
    return this.len;
  }

  get isScrolledUp(): boolean {
    return this.scrollOffset > 0;
  }
}
