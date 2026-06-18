import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { dim } from '../theme.js';

// Maximum number of logical lines retained. Older entries are evicted (FIFO)
// once this cap is exceeded so memory stays bounded for long-running
// workflows. The cap is generous (well above the viewport) to preserve ample
// scroll-back; the TUI only ever displays `maxLines` rows.
const MAX_STORED_LINES = 10000;

export class EventLog implements Component {
  private _lines: string[] = [];
  private maxLines: number;
  private scrollOffset = 0; // 0 = bottom, positive = scrolled up by N rendered lines
  private autoScroll = true;
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;
  private _totalRenderedLines = 0; // cached wrapped-line count at cachedWidth
  // Per-line wrap cache, aligned with _lines (oldest→newest). Each entry stores
  // the wrapped sub-lines for its logical line at `width`, so render() re-wraps
  // only lines whose cached width differs from the current width — never every
  // stored line on each invalidated frame. addLine() is O(1) amortized.
  private lineWrapCache: { width: number; subs: string[] }[] = [];
  private wrappedCache: string[] = []; // flattened expansion of every stored line
  private wrappedWidth = -1; // width at which wrappedCache is currently valid

  constructor(maxLines = 20) {
    this.maxLines = maxLines;
  }

  addLine(text: string): void {
    this._lines.push(text);
    // Keep the rendered-line total cache in sync so handleInput can clamp
    // scroll offsets even before the first render() (WorkflowTUI routes scroll
    // keys before any render frame is produced). Uses the cached width, falling
    // back to 80 when no width is known yet; render() recomputes it exactly.
    const w = this.cachedWidth > 0 ? this.cachedWidth : 80;
    // Wrap the new line once and reuse the result for both the row count and
    // the per-line/incremental caches, so render() never re-wraps the same
    // line again unless the width changes. (wrapTextWithAnsi returns >= 1 row.)
    const wrapped = wrapTextWithAnsi(text, w);
    const wrapCount = wrapped.length;
    // Cache the wrapped result per-line (aligned with _lines) keyed by width;
    // render() reuses it instead of re-wrapping every stored line each frame.
    this.lineWrapCache.push({ width: w, subs: wrapped });
    if (this.cachedWidth > 0) {
      // Width is known and matches the cached expansion: append the new line's
      // wrapped sub-lines so the next width-stable render() can skip the full
      // O(N) re-wrap and just slice a visible window (O(maxLines)).
      for (const sub of wrapped) {
        this.wrappedCache.push(sub);
      }
      this._totalRenderedLines = this.wrappedCache.length;
      this.wrappedWidth = this.cachedWidth;
    } else {
      // No width known yet: keep only the running total; render() will build
      // the wrapped expansion (and correct this count) on first call.
      this._totalRenderedLines += wrapCount;
    }
    // Autoscroll drift fix: when pinned (autoScroll false), bump the offset by
    // the number of rendered rows the new line will occupy at the cached width
    // so the pinned view stays stable. When autoScroll is true, leave the
    // offset at 0 so the view sticks to the newest wrapped lines.
    if (!this.autoScroll) {
      this.scrollOffset += wrapCount;
    }
    // Bounded retention: evict the oldest stored line once the cap is exceeded
    // so memory stays bounded for long-running workflows. Drop its wrapped
    // sub-lines from the leading edge of both caches (when maintained) and keep
    // the rendered-line total / scroll offset consistent so a pinned viewport
    // stays stable. The eviction reuses the cached wrap count (no re-wrap).
    // addLine adds exactly one line, so at most one is evicted per call.
    if (this._lines.length > MAX_STORED_LINES) {
      this._lines.shift();
      const droppedEntry = this.lineWrapCache.shift();
      if (droppedEntry) {
        const droppedWrap = droppedEntry.subs.length;
        if (this.cachedWidth > 0) {
          // wrappedCache is maintained at width w (= cachedWidth): splice off the
          // leading sub-lines that belonged to the evicted logical line.
          this.wrappedCache.splice(0, droppedWrap);
          this._totalRenderedLines = this.wrappedCache.length;
        } else {
          this._totalRenderedLines -= droppedWrap;
        }
      }
      // Clamp the scroll offset to the new rendered-line maximum so a pinned
      // viewport never references rows that no longer exist. When the evicted
      // line was above the viewport the offset is unchanged; it only reduces
      // when the viewport was pinned at the very top.
      this.scrollOffset = Math.max(
        0,
        Math.min(this.scrollOffset, Math.max(0, this._totalRenderedLines - this.maxLines)),
      );
    }
    this.invalidate();
  }

  get lines(): string[] {
    return [...this._lines];
  }

  setMaxLines(n: number): void {
    this.maxLines = n;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this._totalRenderedLines - this.maxLines)));
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines !== null) {
      return this.cachedLines;
    }

    // Keep the per-line wrap cache valid for `width`. Each entry remembers the
    // width it was wrapped at, so on a width-stable frame we re-wrap NOTHING
    // here (zero wrapTextWithAnsi calls — the whole block is skipped); only an
    // actual width change re-wraps, and even then each line is wrapped at most
    // once. The flattened expansion is rebuilt only then; addLine() extends it
    // incrementally otherwise, so the common hot path below is just slicing the
    // visible window — O(maxLines), not O(N).
    if (this.wrappedWidth !== width) {
      for (let i = 0; i < this.lineWrapCache.length; i++) {
        const entry = this.lineWrapCache[i];
        if (entry.width !== width) {
          entry.subs = wrapTextWithAnsi(this._lines[i], width);
          entry.width = width;
        }
      }
      const rebuilt: string[] = [];
      for (const entry of this.lineWrapCache) {
        for (const sub of entry.subs) {
          rebuilt.push(sub);
        }
      }
      this.wrappedCache = rebuilt;
      this.wrappedWidth = width;
      this._totalRenderedLines = rebuilt.length;
    }

    const total = this.wrappedCache.length;
    const contentSlots = this.isScrolledUp ? this.maxLines - 1 : this.maxLines;
    const startIdx = Math.max(0, Math.min(total - contentSlots - this.scrollOffset, total - contentSlots));
    const end = Math.min(total, startIdx + contentSlots);

    const out: string[] = [];
    // When scrolled up, the first row is a dim indicator; content fills the rest.
    if (this.isScrolledUp) {
      const indicator = dim(`↑ ${this.scrollOffset} more lines above (PgUp/PgDn)`);
      out.push(truncateToWidth(indicator, width, undefined, true));
    }
    for (let i = startIdx; i < end; i++) {
      out.push(truncateToWidth(this.wrappedCache[i], width, undefined, true));
    }

    // Pad the TOP with blank width-padded lines so exactly maxLines are returned.
    while (out.length < this.maxLines) {
      out.unshift(truncateToWidth('', width, undefined, true));
    }

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'pageUp')) {
      this.autoScroll = false;
      this.scrollOffset = Math.min(
        this.scrollOffset + Math.max(1, this.maxLines - 1),
        Math.max(0, this._totalRenderedLines - this.maxLines),
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
      this.scrollOffset = Math.max(0, this._totalRenderedLines - this.maxLines);
      this.autoScroll = false;
    } else {
      return;
    }
    this.invalidate();
  }

  get totalLines(): number {
    return this._lines.length;
  }

  get isScrolledUp(): boolean {
    return this.scrollOffset > 0;
  }
}
