import { type Component, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { TaskStatus } from '../../core/types.js';
import { bold, dim, statusColor, statusIcon } from '../theme.js';

// ─── Task Lane ──────────────────────────────────────────────────────────────

export interface TaskLane {
  id: string;
  title: string;
  status: TaskStatus;
  agentId?: string;
  profile?: string;
  stepInfo?: string;
}

// ─── Lane Pool Widget ───────────────────────────────────────────────────────

export class LanePoolWidget implements Component {
  private lanes: TaskLane[] = [];
  private maxLanes: number;
  private focusedLaneIndex = -1;
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(maxLanes: number) {
    this.maxLanes = maxLanes;
  }

  updateLanes(lanes: TaskLane[]): void {
    this.lanes = lanes;
    this.dirty = true;
  }

  setFocusedLane(index: number): void {
    this.focusedLaneIndex = index;
    this.dirty = true;
  }

  getFocusedLaneIndex(): number {
    return this.focusedLaneIndex;
  }

  getLanes(): TaskLane[] {
    return this.lanes;
  }

  getFocusedTaskId(): string | undefined {
    return this.lanes[this.focusedLaneIndex]?.id;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    for (let i = 0; i < this.maxLanes; i++) {
      const lane = this.lanes[i];
      if (lane) {
        let text = statusIcon(lane.status) + ' ' + statusColor(lane.status)(lane.title);
        if (lane.stepInfo) {
          text += ' ' + dim(lane.stepInfo);
        }
        if (i === this.focusedLaneIndex) {
          text = bold(text);
        }
        lines.push(truncateToWidth(text, width, '…', true));
      } else {
        lines.push(truncateToWidth('', width, '…', true));
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up') && this.focusedLaneIndex > 0) {
      this.focusedLaneIndex--;
      this.invalidate();
    } else if (matchesKey(data, 'down') && this.focusedLaneIndex < this.lanes.length - 1) {
      this.focusedLaneIndex++;
      this.invalidate();
    }
  }
}
