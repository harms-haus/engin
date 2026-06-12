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
      let text = statusIcon(lane.status) + ' ' + statusColor(lane.status)(lane.title);
      if (lane.stepInfo) {
        text += ' ' + dim(lane.stepInfo);
      }
      if (lane.phase) {
        text += ' ' + dim('[' + lane.phase + ']');
      }
      if (lane.startedAt) {
        text += ' ' + dim(formatElapsed(Date.now() - lane.startedAt));
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
