import { type Component, truncateToWidth } from '@earendil-works/pi-tui';
import { bold, cyan, dim, green, underline } from '../theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PhaseDescriptor {
  id: string;
  label: string;
  icon: string;
}

// ─── PhaseBar Component ─────────────────────────────────────────────────────

export class PhaseBar implements Component {
  private phases: PhaseDescriptor[] = [];
  private completedPhases = new Set<string>();
  private currentPhaseId = '';
  private selectedPhaseId: string | null = null;
  private indicator = '';
  private dirty = true;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  setPhases(phases: PhaseDescriptor[]): void {
    this.phases = phases;
    this.dirty = true;
  }

  setCurrentPhase(id: string): void {
    this.currentPhaseId = id;
    this.selectedPhaseId = null;
    this.dirty = true;
  }

  setSelectedPhase(id: string): void {
    this.selectedPhaseId = id;
    this.dirty = true;
  }

  setCompletedPhases(ids: string[]): void {
    this.completedPhases = new Set(ids);
    this.dirty = true;
  }

  setIndicator(icon: string): void {
    this.indicator = icon;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width) {
      return this.cachedLines;
    }

    let line: string;

    if (this.phases.length === 0) {
      // No phases: render indicator and/or currentPhaseId
      const parts: string[] = [];
      if (this.indicator) parts.push(this.indicator);
      if (this.currentPhaseId) parts.push(this.currentPhaseId);
      line = parts.join(' ');
    } else {
      // Build phase segments
      const effectiveSelected = this.selectedPhaseId ?? this.currentPhaseId;
      const segments: string[] = [];
      for (const phase of this.phases) {
        const completed = this.completedPhases.has(phase.id);
        const running = phase.id === this.currentPhaseId;
        const selected = phase.id === effectiveSelected;
        const marker = completed ? green('✓') : running ? cyan('●') : dim('·');
        const baseLabel = completed ? phase.label : running ? bold(phase.label) : phase.label;
        const label = selected ? underline(baseLabel) : !completed && !running ? dim(baseLabel) : baseLabel;
        segments.push(marker + ' ' + label);
      }
      line = segments.join(dim(' │ '));

      // Prepend indicator if set
      if (this.indicator) {
        line = this.indicator + ' ' + line;
      }
    }

    line = truncateToWidth(line, width, undefined, true);

    this.cachedWidth = width;
    this.cachedLines = [line];
    this.dirty = false;
    return this.cachedLines;
  }
}
