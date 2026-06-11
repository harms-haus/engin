/**
 * Tests for web/src/index.css
 *
 * Verifies that the CSS custom properties defined in :root include the
 * required ROYGBIV phase colors with correct values and placement.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from 'vitest';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read the CSS file content (synchronous, safe in Vitest). */
function readCss(): string {
  const filePath = resolve(__dirname, '../index.css');
  return readFileSync(filePath, 'utf-8');
}

/** Extract the content of the :root block from the CSS string. */
function extractRootBlock(css: string): string {
  const match = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!match) {
    throw new Error(':root block not found in CSS');
  }
  return match[1];
}

// ─── Phase color definitions ────────────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  '--engin-phase-0': '#e74c3c', // red – initialization
  '--engin-phase-1': '#e67e22', // orange – scouting
  '--engin-phase-2': '#f1c40f', // yellow – scouting review
  '--engin-phase-3': '#2ecc71', // green – planning
  '--engin-phase-4': '#1abc9c', // teal – plan review
  '--engin-phase-5': '#3498db', // blue – implementing
  '--engin-phase-6': '#9b59b6', // purple – final review
};

const SPECIAL_PHASE_PROPS: Record<string, string> = {
  '--engin-phase-disabled': '#6e7681',
  '--engin-phase-disabled-opacity': '0.4',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('index.css – :root custom properties', () => {
  let rootBlock: string;

  beforeAll(() => {
    const css = readCss();
    rootBlock = extractRootBlock(css);
  });

  // ── ROYGBIV phase colors ────────────────────────────────────────────────

  describe('phase color properties', () => {
    for (const [prop, expected] of Object.entries(PHASE_COLORS)) {
      it(`should define ${prop} with value ${expected}`, () => {
        // Match property name followed by colon, optional whitespace, and the value.
        const pattern = new RegExp(`${escapeRegex(prop)}\\s*:\\s*${escapeRegex(expected)}\\s*;`);
        expect(rootBlock).toMatch(pattern);
      });
    }
  });

  // ── Special phase properties ────────────────────────────────────────────

  describe('special phase properties', () => {
    it('should define --engin-phase-disabled with gray value', () => {
      const pattern = new RegExp(`${escapeRegex('--engin-phase-disabled')}\\s*:\\s*#6e7681\\s*;`);
      expect(rootBlock).toMatch(pattern);
    });

    it('should define --engin-phase-disabled-opacity with value 0.4', () => {
      const pattern = new RegExp(`${escapeRegex('--engin-phase-disabled-opacity')}\\s*:\\s*0\\.4\\s*;`);
      expect(rootBlock).toMatch(pattern);
    });
  });

  // ── Placement ───────────────────────────────────────────────────────────

  describe('placement within :root', () => {
    it('should place phase colors after the existing accent/status colors', () => {
      // The last "color" property before layout properties is --engin-error.
      // Phase colors should come after it.
      const errorIdx = rootBlock.indexOf('--engin-error');
      const firstPhaseIdx = rootBlock.indexOf('--engin-phase-0');

      expect(errorIdx).toBeGreaterThan(-1);
      expect(firstPhaseIdx).toBeGreaterThan(-1);
      expect(firstPhaseIdx).toBeGreaterThan(errorIdx);
    });

    it('should place phase colors before the layout properties', () => {
      // The first layout property is --engin-sidebar-width.
      const firstPhaseIdx = rootBlock.indexOf('--engin-phase-0');
      const sidebarIdx = rootBlock.indexOf('--engin-sidebar-width');

      expect(firstPhaseIdx).toBeGreaterThan(-1);
      expect(sidebarIdx).toBeGreaterThan(-1);
      expect(firstPhaseIdx).toBeLessThan(sidebarIdx);
    });

    it('should place disabled phase properties immediately after the numbered phases', () => {
      const lastNumberedIdx = rootBlock.lastIndexOf('--engin-phase-6');
      const disabledIdx = rootBlock.indexOf('--engin-phase-disabled');
      const disabledOpacityIdx = rootBlock.indexOf('--engin-phase-disabled-opacity');

      expect(lastNumberedIdx).toBeLessThan(disabledIdx);
      expect(disabledIdx).toBeLessThan(disabledOpacityIdx);
    });
  });

  // ── Comment ─────────────────────────────────────────────────────────────

  describe('theme-dependent comment', () => {
    it('should include a comment about overriding for light themes', () => {
      const css = readCss();
      // Look for a comment near the phase colors mentioning "light theme" or "theme-dependent"
      const commentPattern = /\/\*[\s\S]*?(?:theme[- ]depend|light[- ]theme|override)[\s\S]*?\*\//i;
      expect(css).toMatch(commentPattern);
    });
  });

  // ── Syntax validity ─────────────────────────────────────────────────────

  describe('CSS syntax validity', () => {
    it('should have balanced braces in the :root block', () => {
      const opens = (rootBlock.match(/{/g) || []).length;
      const closes = (rootBlock.match(/}/g) || []).length;
      expect(opens).toBe(closes);
    });

    it('should have all phase properties ending with semicolons', () => {
      const allProps = Object.keys({ ...PHASE_COLORS, ...SPECIAL_PHASE_PROPS });
      for (const prop of allProps) {
        // Find the line containing this property
        const lines = rootBlock.split('\n');
        const propLine = lines.find((l) => l.includes(prop));
        expect(propLine).toBeDefined();
        // Strip any trailing comment and whitespace, then check it ends with ;
        const stripped = propLine!.replace(/\/\*.*?\*\//, '').trim();
        expect(stripped.endsWith(';')).toBe(true);
      }
    });

    it('should have exactly 9 phase-related properties (7 numbered + disabled + disabled-opacity)', () => {
      const phaseLines = rootBlock
        .split('\n')
        .filter((line) => /--engin-phase(-\d|-disabled|-disabled-opacity)\s*:/.test(line));
      expect(phaseLines).toHaveLength(9);
    });
  });
});

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
