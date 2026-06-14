import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { TaskStatus } from '../../core/types.js';
import { bold, dim, formatElapsed, statusColor, statusIcon } from '../theme.js';

// ─── Task Lane ──────────────────────────────────────────────────────────────

export interface TaskLane {
  id: string;
  title: string;
  status: TaskStatus;
  agentId?: string;
  profile?: string;
  stepInfo?: string;
  phase?: string;
  startedAt?: number;
  completedAt?: number;
}

// ─── Status Priority ────────────────────────────────────────────────────────

const statusPriority: Record<TaskStatus, number> = {
  implementing: 0,
  reviewing: 0,
  claimed: 1,
  ready: 2,
  blocked: 3,
  done: 4,
  failed: 4,
};

// ─── Lane Pool Widget ───────────────────────────────────────────────────────

export class LanePoolWidget implements Component {
  private lanes: TaskLane[] = [];
  private focusedLaneId: string | null = null;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private sortedCache: TaskLane[] | null = null;

  /** Lazily computes and caches the sorted lane list. */
  private ensureSorted(): TaskLane[] {
    if (this.sortedCache === null) {
      this.sortedCache = [...this.lanes].sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);
    }
    return this.sortedCache;
  }

  /** Clears the sorted cache (call whenever lanes or focus change). */
  private invalidateCache(): void {
    this.sortedCache = null;
    this.dirty = true;
  }

  updateLanes(lanes: TaskLane[]): void {
    this.lanes = lanes;
    if (this.focusedLaneId !== null && !lanes.some((l) => l.id === this.focusedLaneId)) {
      this.focusedLaneId = null;
    }
    this.invalidateCache();
  }

  /** Focuses the lane with the given task ID. No-op if the ID doesn't exist. */
  setFocusedLaneById(id: string): void {
    if (this.lanes.some((l) => l.id === id)) {
      this.focusedLaneId = id;
      this.dirty = true;
    }
  }

  getFocusedLaneIndex(): number {
    if (this.focusedLaneId === null) return -1;
    const sorted = this.getSortedLanes();
    return sorted.findIndex((lane) => lane.id === this.focusedLaneId);
  }

  getLanes(): TaskLane[] {
    return this.lanes;
  }

  getFocusedTaskId(): string | undefined {
    return this.focusedLaneId ?? undefined;
  }

  /** Returns a shallow copy of lanes sorted by status priority (ascending). */
  getSortedLanes(): TaskLane[] {
    return [...this.ensureSorted()];
  }

  /** Returns the currently focused lane from the sorted list, or undefined. */
  getFocusedLane(): TaskLane | undefined {
    if (this.focusedLaneId === null) return undefined;
    return this.ensureSorted().find((l) => l.id === this.focusedLaneId);
  }

  invalidate(): void {
    this.invalidateCache();
  }

  getVisibleLaneCount(): number {
    return this.lanes.length;
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const sorted = this.ensureSorted();
    const lines: string[] = [];

    for (const lane of sorted) {
      // Compute elapsed time string if startedAt exists.
      // NOTE: This uses wall-clock time (Date.now() - startedAt for active tasks,
      // completedAt - startedAt for done/failed tasks) as an INTENTIONAL SIMPLIFICATION.
      // True summed-per-agent-duration tracking would require additional timer
      // fields in the registry, which is out of scope for this rewrite.
      let elapsed: string | undefined;
      if (lane.startedAt !== undefined) {
        const endTime = lane.completedAt ?? Date.now();
        elapsed = dim(formatElapsed(endTime - lane.startedAt));
      }

      let text: string;
      const iconTitle = statusIcon(lane.status) + ' ' + statusColor(lane.status)(lane.title);

      if (lane.status === 'implementing' || lane.status === 'reviewing' || lane.status === 'claimed') {
        // Branch A (active): {icon} {colored title} - {dim status text} - {dim elapsed}
        text = iconTitle + ' - ' + dim(lane.stepInfo ?? lane.status);
        if (elapsed !== undefined) {
          text += ' - ' + elapsed;
        }
      } else if (lane.status === 'blocked' || lane.status === 'ready') {
        // Branch B (blocked, ready): {icon} {colored title} only
        text = iconTitle;
      } else {
        // Branch C (done, failed): {icon} {colored title} - {dim elapsed}
        text = iconTitle;
        if (elapsed !== undefined) {
          text += ' - ' + elapsed;
        }
      }

      if (lane.id === this.focusedLaneId) {
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
    const currentIndex = this.focusedLaneId !== null ? sorted.findIndex((lane) => lane.id === this.focusedLaneId) : -1;

    if (matchesKey(data, 'up') && currentIndex > 0) {
      this.focusedLaneId = sorted[currentIndex - 1].id;
      this.invalidate();
    } else if (matchesKey(data, 'down') && currentIndex < sorted.length - 1) {
      this.focusedLaneId = sorted[currentIndex + 1].id;
      this.invalidate();
    }
  }
}
