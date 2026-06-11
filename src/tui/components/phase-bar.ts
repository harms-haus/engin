import { type Component, truncateToWidth } from '@earendil-works/pi-tui';
import { bold, cyan, dim, green } from '../theme.js';

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
      const segments: string[] = [];
      for (const phase of this.phases) {
        if (this.completedPhases.has(phase.id)) {
          segments.push(green('✓') + ' ' + phase.label);
        } else if (phase.id === this.currentPhaseId) {
          segments.push(cyan('●') + ' ' + bold(phase.label));
        } else {
          segments.push(dim('·') + ' ' + dim(phase.label));
        }
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
