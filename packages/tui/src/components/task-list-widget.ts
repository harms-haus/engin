import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { TaskEntity } from '@engin/shared';
import { bold, dim, formatElapsed, statusColor, statusIcon, yellow } from '../theme.js';

// ─── Task List Widget ───────────────────────────────────────────────────────

export class TaskListWidget implements Component {
  private tasks: TaskEntity[] = [];
  private selectedTaskId: string | null = null;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private orderedCache: TaskEntity[] | null = null;

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

  /** Clears the ordered cache (call whenever tasks or selection change). */
  private invalidateCache(): void {
    this.orderedCache = null;
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
    return this.ensureOrdered().find((t) => t.id === this.selectedTaskId);
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

    const ordered = this.ensureOrdered();
    const lines: string[] = [];

    for (const task of ordered) {
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

      // ── Dependencies ──
      if (task.dependencies.length > 0) {
        const taskMap = new Map(this.tasks.map((t) => [t.id, t]));
        const depParts = task.dependencies.map((depId) => {
          const depTask = taskMap.get(depId);
          if (depTask === undefined || depTask.status === 'complete') {
            return dim(depId);
          }
          return yellow(depId);
        });
        text += ' - deps: ' + depParts.join(', ');
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
    const ordered = this.ensureOrdered();
    const currentIndex = this.selectedTaskId !== null ? ordered.findIndex((t) => t.id === this.selectedTaskId) : -1;

    if (matchesKey(data, 'up') && currentIndex > 0) {
      this.selectedTaskId = ordered[currentIndex - 1].id;
      this.invalidate();
    } else if (matchesKey(data, 'down') && currentIndex < ordered.length - 1) {
      this.selectedTaskId = ordered[currentIndex + 1].id;
      this.invalidate();
    }
  }
}
