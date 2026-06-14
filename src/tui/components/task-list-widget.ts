import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { TaskEntity } from '../../tracking/event-types.js';
import { bold, dim, formatElapsed, statusColor, statusIcon } from '../theme.js';

// ─── Status Priority ────────────────────────────────────────────────────────

const statusPriority: Record<string, number> = {
  active: 0,
  ready: 1,
  blocked: 2,
  complete: 3,
  failed: 3,
  cancelled: 3,
};

// ─── Task List Widget ───────────────────────────────────────────────────────

export class TaskListWidget implements Component {
  private tasks: TaskEntity[] = [];
  private selectedTaskId: string | null = null;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private sortedCache: TaskEntity[] | null = null;

  /** Lazily computes and caches the sorted task list. */
  private ensureSorted(): TaskEntity[] {
    if (this.sortedCache === null) {
      this.sortedCache = [...this.tasks].sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);
    }
    return this.sortedCache;
  }

  /** Clears the sorted cache (call whenever tasks or selection change). */
  private invalidateCache(): void {
    this.sortedCache = null;
    this.dirty = true;
  }

  updateTasks(tasks: TaskEntity[]): void {
    this.tasks = tasks;
    if (this.selectedTaskId !== null && !tasks.some((t) => t.id === this.selectedTaskId)) {
      this.selectedTaskId = null;
    }
    this.invalidateCache();
  }

  setSelectedTaskId(id: string | null): void {
    if (id === null || this.tasks.some((t) => t.id === id)) {
      this.selectedTaskId = id;
      this.dirty = true;
    }
  }

  getSelectedTaskId(): string | null {
    return this.selectedTaskId;
  }

  getSelectedTask(): TaskEntity | undefined {
    if (this.selectedTaskId === null) return undefined;
    return this.ensureSorted().find((t) => t.id === this.selectedTaskId);
  }

  getVisibleTaskCount(): number {
    return this.tasks.length;
  }

  invalidate(): void {
    this.invalidateCache();
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const sorted = this.ensureSorted();
    const lines: string[] = [];

    for (const task of sorted) {
      let text: string;

      const iconTitle = statusIcon(task.status) + ' ' + statusColor(task.status)(task.title);

      // ── Active task with step annotation ──
      if (task.status === 'active' && task.activeStepIndex !== undefined && task.steps[task.activeStepIndex]) {
        const step = task.steps[task.activeStepIndex];
        const stepLabel = `step ${task.activeStepIndex + 1}/${task.steps.length}: ${step.name}`;
        text = iconTitle + ' - ' + dim(stepLabel);
      } else if (task.status === 'active') {
        // Active without step info just shows status
        text = iconTitle + ' - ' + dim(task.status);
      } else if (task.status === 'blocked' || task.status === 'ready') {
        text = iconTitle;
      } else {
        // complete / failed / cancelled
        text = iconTitle;
      }

      // ── Elapsed time (not shown for ready/blocked) ──
      if (
        (task.status === 'active' ||
          task.status === 'complete' ||
          task.status === 'failed' ||
          task.status === 'cancelled') &&
        task.startedAt !== undefined
      ) {
        const endTime = task.completedAt !== undefined ? new Date(task.completedAt).getTime() : Date.now();
        const elapsed = dim(formatElapsed(endTime - task.startedAt));
        text += ' - ' + elapsed;
      }

      if (task.id === this.selectedTaskId) {
        text = bold(text);
      }
      lines.push(truncateToWidth(text, width, '…', true));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  handleInput(data: string): void {
    const sorted = this.ensureSorted();
    const currentIndex = this.selectedTaskId !== null ? sorted.findIndex((t) => t.id === this.selectedTaskId) : -1;

    if (matchesKey(data, 'up') && currentIndex > 0) {
      this.selectedTaskId = sorted[currentIndex - 1].id;
      this.invalidate();
    } else if (matchesKey(data, 'down') && currentIndex < sorted.length - 1) {
      this.selectedTaskId = sorted[currentIndex + 1].id;
      this.invalidate();
    }
  }
}
