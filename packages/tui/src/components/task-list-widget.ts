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

    // ── Build the 5 column cells for each task ──
    const idCells: string[] = [];
    const iconCells: string[] = [];
    const titleCells: string[] = [];
    const stepCells: string[] = [];
    const depsCells: string[] = [];

    // Selection is applied per-cell (via bold()) rather than wrapping the
    // assembled row: inner ANSI resets emitted by dim()/statusColor() would
    // otherwise clear the bold attribute mid-row, leaving only the first cell
    // (the dim ID) visually bold.
    for (const task of ordered) {
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
        step = dim(`step ${task.activeStepIndex + 1}/${task.steps.length}: ${task.steps[task.activeStepIndex].name}`);
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

    // ── Compute the visible index range (≤20 rows) BEFORE column widths ──
    // Column widths are computed from only the visible viewport window so an
    // off-screen task with a long title doesn't widen the title column (and
    // truncate the deps/steps columns) for the rows that are actually emitted.
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

    // ── Compute column widths from the visible viewport window only ──
    const colWidth = (cells: string[]): number => {
      let max = 0;
      for (let i = start; i < end; i++) {
        max = Math.max(max, visibleWidth(cells[i]));
      }
      return max;
    };
    const idWidth = colWidth(idCells);
    const iconWidth = colWidth(iconCells);
    const titleWidth = colWidth(titleCells);
    const stepWidth = colWidth(stepCells);
    const depsWidth = colWidth(depsCells);

    for (let i = start; i < end; i++) {
      // Pad/truncate each cell to its column width. Skip empty columns entirely
      // (column width 0) so no trailing gap/cell is emitted.
      const segments: string[] = [
        truncateToWidth(idCells[i], idWidth, '…', true),
        truncateToWidth(iconCells[i], iconWidth, '…', true),
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
