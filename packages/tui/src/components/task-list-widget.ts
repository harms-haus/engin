import { type Component, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { TaskEntity } from '@engin/shared';
import { bold, dim, formatElapsed, normal, statusColor, statusIcon } from '../theme.js';

// ─── Task List Widget ───────────────────────────────────────────────────────

export class TaskListWidget implements Component {
  private tasks: TaskEntity[] = [];
  private selectedTaskId: string | null = null;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private orderedCache: TaskEntity[] | null = null;
  private idLabelCache: Map<string, string> | null = null;
  private _scrollOffset = 0;
  private readonly _maxVisibleLines = 20;

  /**
   * Lazily computes and caches the task list in creation/registration order
   * (i.e. the order tasks arrive via updateTasks, which is registration order).
   */
  private ensureOrdered(): TaskEntity[] {
    if (this.orderedCache === null) {
      this.orderedCache = [...this.tasks];
    }
    return this.orderedCache;
  }

  /**
   * Lazily builds a map of task id → compact display label (e.g. `t-01`),
   * assigned in creation/registration order. Used for both the ID column and
   * the dependencies column so the two stay cross-referenceable without
   * printing the full (often slug-like) task id. Dependency ids that are not
   * present in the current task set (e.g. cross-phase deps) have no label and
   * fall back to their raw id when rendered.
   */
  private ensureIdLabels(): Map<string, string> {
    if (this.idLabelCache === null) {
      const ordered = this.ensureOrdered();
      const width = Math.max(2, String(ordered.length).length);
      const map = new Map<string, string>();
      ordered.forEach((task, i) => {
        map.set(task.id, 't-' + String(i + 1).padStart(width, '0'));
      });
      this.idLabelCache = map;
    }
    return this.idLabelCache;
  }

  /** Clears the ordered cache (call whenever tasks or selection change). */
  private invalidateCache(): void {
    this.orderedCache = null;
    this.idLabelCache = null;
    this.dirty = true;
  }

  /**
   * Computes how many task rows fit in the current viewport given the
   * current `_scrollOffset`. Reserves one slot for a top '...' indicator when
   * scrolled down, and one slot for a bottom '...' indicator when more tasks
   * remain below the fold.
   */
  private _getViewportTaskCount(): number {
    const hasAbove = this._scrollOffset > 0;
    let slots = this._maxVisibleLines - (hasAbove ? 1 : 0);
    const remaining = this.tasks.length - this._scrollOffset;
    const hasBelow = remaining > slots;
    if (hasBelow) slots -= 1;
    return Math.min(slots, remaining);
  }

  /**
   * When a task newly transitions to `active`, slide the viewport so that as
   * many running (active) tasks as possible are visible. Uses a fixed window of
   * `_maxVisibleLines` (the approximation noted in the spec: the real visible
   * slot count can be ~2 smaller when the top/bottom `… more` indicator rows
   * are present, but the resulting position is at most ~2 rows suboptimal).
   *
   * Computes, for each candidate start offset `s` in `[0, ordered.length - 1]`,
   * how many currently-`active` tasks have index in `[s, s + W)` in a single
   * O(n) pass via a difference array (rather than re-counting per offset).
   * Picks the offset that MAXIMIZES this count. Tie-break: if the current
   * `_scrollOffset` achieves the maximum, keep it (avoids jitter); otherwise
   * choose the smallest offset achieving the maximum.
   */
  private _autoScrollToActive(): void {
    const ordered = this.ensureOrdered();
    if (ordered.length === 0) return;

    const W = this._maxVisibleLines;
    const activeIndices: number[] = [];
    ordered.forEach((task, i) => {
      if (task.status === 'active') activeIndices.push(i);
    });
    if (activeIndices.length === 0) return;

    const maxOffset = ordered.length - 1;

    // Difference array of length `maxOffset + 2` (the extra slot holds the
    // exclusive range-end decrement). For each active index `i`, the offsets
    // `s` whose window `[s, s + W)` contains `i` form the contiguous range
    // `[max(0, i - W + 1), i]`; mark it with `+1` at the start and `-1` just
    // past the end, then prefix-sum in place so `count[s]` becomes the number
    // of active indices in `[s, s + W)`. This is O(n + a) total.
    const count = new Array<number>(maxOffset + 2).fill(0);
    for (const i of activeIndices) {
      count[Math.max(0, i - W + 1)] += 1;
      count[Math.min(maxOffset + 1, i + 1)] -= 1;
    }
    for (let s = 1; s <= maxOffset; s++) {
      count[s] += count[s - 1];
    }

    // Single forward scan: track the SMALLEST offset achieving the max count.
    let bestCount = -1;
    let bestOffset = 0;
    for (let s = 0; s <= maxOffset; s++) {
      if (count[s] > bestCount) {
        bestCount = count[s];
        bestOffset = s;
      }
    }

    // Tie-break: prefer the current offset if it achieves the maximum
    // (avoids jitter); otherwise choose the smallest offset achieving it.
    const current = Math.max(0, Math.min(this._scrollOffset, maxOffset));
    let chosen: number;
    if (count[current] === bestCount) {
      chosen = current;
    } else {
      chosen = bestOffset;
    }
    chosen = Math.max(0, Math.min(chosen, maxOffset));

    if (chosen !== this._scrollOffset) {
      this._scrollOffset = chosen;
      this.dirty = true;
    }
  }

  /**
   * Adjusts `_scrollOffset` so the task at `index` is within the viewport.
   * Scrolls up to show an above-viewport task at the top, or scrolls down
   * incrementally until a below-viewport task becomes visible.
   */
  private _ensureVisible(index: number): void {
    // If above viewport, scroll up to show it at top
    if (index < this._scrollOffset) {
      this._scrollOffset = index;
      this.dirty = true;
      return;
    }
    // If below viewport, scroll down until visible
    while (this._scrollOffset + this._getViewportTaskCount() <= index && this._scrollOffset < this.tasks.length - 1) {
      this._scrollOffset++;
      this.dirty = true;
    }
  }

  updateTasks(tasks: TaskEntity[]): void {
    // Capture the previous status of each task (by id) BEFORE reassignment so
    // we can detect which tasks newly transitioned to `active`.
    const oldStatusById = new Map(this.tasks.map((t) => [t.id, t.status]));
    const oldIds = new Set(this.tasks.map((t) => t.id));
    const oldLength = this.tasks.length;
    this.tasks = tasks;
    // Reset the viewport when the set of task IDs changes (e.g. phase switch).
    if (tasks.length !== oldLength || tasks.some((t) => !oldIds.has(t.id))) {
      this._scrollOffset = 0;
    }
    if (this.selectedTaskId !== null && !tasks.some((t) => t.id === this.selectedTaskId)) {
      this.selectedTaskId = null;
    }
    this.invalidateCache();

    // If any task newly transitioned to `active` (it existed before with a
    // non-active status and is now `active`), re-fit the viewport to show as
    // many running tasks as possible. Runs AFTER the ID-set-change reset and
    // cache invalidation so the viewport math sees the new list and ordering.
    // A freshly-loaded phase (no old counterpart for these ids) does NOT count
    // as a transition, so auto-scroll does not override the phase-switch reset.
    const newlyActive = tasks.some(
      (t) => t.status === 'active' && oldStatusById.has(t.id) && oldStatusById.get(t.id) !== 'active',
    );
    if (newlyActive) {
      this._autoScrollToActive();
    }
  }

  setSelectedTaskId(id: string | null): void {
    if (id === null || this.tasks.some((t) => t.id === id)) {
      this.selectedTaskId = id;
      this.dirty = true;
      if (id !== null) {
        const ordered = this.ensureOrdered();
        const idx = ordered.findIndex((t) => t.id === id);
        if (idx >= 0) this._ensureVisible(idx);
      }
    }
  }

  getSelectedTaskId(): string | null {
    return this.selectedTaskId;
  }

  getSelectedTask(): TaskEntity | undefined {
    if (this.selectedTaskId === null) return undefined;
    return this.ensureOrdered().find((t) => t.id === this.selectedTaskId);
  }

  getVisibleTaskCount(): number {
    return this.tasks.length;
  }

  /**
   * The number of lines the widget will render, i.e. the task count capped by
   * `_maxVisibleLines`. The viewport-cap logic lives here so callers (e.g.
   * Dashboard.getComputedHeight) don't re-derive the cap with a magic number.
   */
  getRenderedLineCount(): number {
    return Math.min(this._maxVisibleLines, this.tasks.length);
  }

  invalidate(): void {
    this.invalidateCache();
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const ordered = this.ensureOrdered();
    const taskMap = new Map(this.tasks.map((t) => [t.id, t]));
    const idLabels = this.ensureIdLabels();

    // ── Compute the visible index range (≤20 rows) BEFORE building cells ──
    // The viewport window is computed up-front so cell building (coloring,
    // formatting, elapsed-time, dep lookups) is limited to visible rows only.
    let start: number;
    let end: number;
    if (ordered.length <= this._maxVisibleLines) {
      // No viewport logic needed — render all rows.
      start = 0;
      end = ordered.length;
    } else {
      // Clamp the scroll offset into a valid range.
      this._scrollOffset = Math.max(0, Math.min(this._scrollOffset, ordered.length - 1));
      start = this._scrollOffset;
      end = this._scrollOffset + this._getViewportTaskCount();
    }

    // ── Build the 5 column cells for each VISIBLE task only ──
    const idCells: string[] = [];
    const iconCells: string[] = [];
    const titleCells: string[] = [];
    const stepCells: string[] = [];
    const depsCells: string[] = [];

    // Selection is applied per-cell (via bold()) rather than wrapping the
    // assembled row: inner ANSI resets emitted by dim()/statusColor() would
    // otherwise clear the bold attribute mid-row, leaving only the first cell
    // (the dim ID) visually bold.
    for (let i = start; i < end; i++) {
      const task = ordered[i];
      const selected = task.id === this.selectedTaskId;
      const maybeBold = (cell: string): string => (selected && cell !== '' ? bold(cell) : cell);

      // 1. ID column — compact cross-referenceable label (t-01…), dimmed.
      idCells.push(maybeBold(dim(idLabels.get(task.id) ?? task.id)));

      // 2. Status icon column (no color wrapper)
      iconCells.push(maybeBold(statusIcon(task.status)));

      // 3. Title + elapsed-time column
      let title = statusColor(task.status)(task.title);
      if (
        task.startedAt !== undefined &&
        (task.status === 'active' ||
          task.status === 'complete' ||
          task.status === 'failed' ||
          task.status === 'cancelled')
      ) {
        const endTime = task.completedAt !== undefined ? new Date(task.completedAt).getTime() : Date.now();
        title += ' - ' + dim(formatElapsed(endTime - task.startedAt));
      }
      titleCells.push(maybeBold(title));

      // 4. Step-progress column (only for active multi-step tasks)
      let step = '';
      if (
        task.status === 'active' &&
        task.steps.length > 1 &&
        task.activeStepIndex !== undefined &&
        task.steps[task.activeStepIndex] !== undefined
      ) {
        step = dim(`${task.activeStepIndex + 1}/${task.steps.length} ${task.steps[task.activeStepIndex].name}`);
      }
      stepCells.push(maybeBold(step));

      // 5. Dependencies column (bare comma-separated dep IDs, no 'deps:' prefix)
      let deps = '';
      if (task.dependencies.length > 0) {
        const parts = task.dependencies.map((depId) => {
          const depTask = taskMap.get(depId);
          const label = idLabels.get(depId) ?? depId;
          if (depTask === undefined || depTask.status !== 'complete') {
            return normal(label);
          }
          return dim(label);
        });
        deps = parts.join(', ');
      }
      depsCells.push(maybeBold(deps));
    }

    const GAP = '  ';
    const lines: string[] = [];

    // ── Compute column widths from the visible viewport window only ──
    // (Cells only contain visible entries, so iterate 0..cells.length.)
    const colWidth = (cells: string[]): number => {
      let max = 0;
      for (const cell of cells) {
        max = Math.max(max, visibleWidth(cell));
      }
      return max;
    };
    const idWidth = colWidth(idCells);
    const iconWidth = colWidth(iconCells);
    const titleWidth = colWidth(titleCells);
    const stepWidth = colWidth(stepCells);
    const depsWidth = colWidth(depsCells);

    for (let i = 0; i < idCells.length; i++) {
      // Pad/truncate each cell to its column width. Skip empty columns entirely
      // (column width 0) so no trailing gap/cell is emitted.
      const segments: string[] = [
        truncateToWidth(iconCells[i], iconWidth, '…', true),
        truncateToWidth(idCells[i], idWidth, '…', true),
        truncateToWidth(titleCells[i], titleWidth, '…', true),
      ];
      if (stepWidth > 0) {
        segments.push(truncateToWidth(stepCells[i], stepWidth, '…', true));
      }
      if (depsWidth > 0) {
        segments.push(truncateToWidth(depsCells[i], depsWidth, '…', true));
      }

      let row = segments.join(GAP);

      // Fallback truncation for very narrow terminals (do NOT pad to width).
      if (visibleWidth(row) > width) {
        row = truncateToWidth(row, width, '…', false);
      }

      lines.push(row);
    }

    // ── Apply viewport windowing (20-line cap with edge-scrolling) ──
    let output: string[];
    if (ordered.length <= this._maxVisibleLines) {
      // No viewport logic needed — render all rows as-is.
      output = lines;
    } else {
      const taskSlots = end - start;
      const hasAbove = this._scrollOffset > 0;
      const hasBelow = this._scrollOffset + taskSlots < ordered.length;

      output = [];
      const hiddenBelow = ordered.length - (this._scrollOffset + taskSlots);
      if (hasAbove) {
        output.push(truncateToWidth(dim(`↑ ${this._scrollOffset} more above (↑/↓)`), width, undefined, true));
      }
      for (const row of lines) {
        output.push(row);
      }
      if (hasBelow) {
        output.push(truncateToWidth(dim(`↓ ${hiddenBelow} more below (↑/↓)`), width, undefined, true));
      }

      // Pad to a consistent height for dashboard layout computation.
      const targetHeight = Math.min(this._maxVisibleLines, ordered.length);
      while (output.length < targetHeight) output.push('');
    }

    this.cachedLines = output;
    this.cachedWidth = width;
    this.dirty = false;
    return output;
  }

  handleInput(data: string): void {
    const ordered = this.ensureOrdered();
    const currentIndex = this.selectedTaskId !== null ? ordered.findIndex((t) => t.id === this.selectedTaskId) : -1;

    if (matchesKey(data, 'up') && currentIndex > 0) {
      this.selectedTaskId = ordered[currentIndex - 1].id;
      this.invalidate();
      this._ensureVisible(currentIndex - 1);
    } else if (matchesKey(data, 'down') && currentIndex < ordered.length - 1) {
      this.selectedTaskId = ordered[currentIndex + 1].id;
      this.invalidate();
      this._ensureVisible(currentIndex + 1);
    }
  }
}
