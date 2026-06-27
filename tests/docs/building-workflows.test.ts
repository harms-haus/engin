// ─── Documentation: building-workflows.md createHarness removal ────────────
//
// CONTRACT UNDER TEST (docs/guides/building-workflows.md):
//
// `createHarness` was removed from the engine. The building-workflows guide
// must not reference it anywhere — not in the runStepTask lifecycle description,
// not in the lane-processing narrative, and not in the testing guidance. The
// guide must instead use the current agent-plugin terminology
// (`createSession`, `spawnAgent`, `AgentRuntime`, `PromptableHarness`).

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GUIDE_PATH = resolve(import.meta.dir, '../../docs/guides/building-workflows.md');

const guide = readFileSync(GUIDE_PATH, 'utf-8');

/**
 * Extract a contiguous block of lines from `text`, starting at the first line
 * that contains `startMarker` and ending at the first subsequent blank line
 * (or `endMarker` if provided).
 */
function extractBlock(text: string, startMarker: string): string {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx === -1) return '';
  const block: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (i > startIdx && lines[i].trim() === '' && lines[i - 1].trim() === '') {
      break;
    }
    if (i > startIdx && lines[i].startsWith('---')) {
      break;
    }
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('docs/guides/building-workflows.md — createHarness removal', () => {
  // ── No references to the removed symbol ──────────────────────────────────

  it('does not mention createHarness anywhere in the guide', () => {
    expect(guide).not.toContain('createHarness');
  });

  it('does not mention createHarness in any casing', () => {
    expect(guide.toLowerCase()).not.toContain('createharness');
  });

  // ── runStepTask lifecycle (around line 210) ──────────────────────────────

  describe('runStepTask lifecycle wording', () => {
    const lifecycle = extractBlock(guide, 'Lifecycle: abort check');

    it('contains the lifecycle paragraph', () => {
      expect(lifecycle).not.toBe('');
      expect(lifecycle).toContain('Lifecycle:');
    });

    it('does not reference createHarness', () => {
      expect(lifecycle).not.toContain('createHarness');
    });

    it('mentions createSession', () => {
      expect(lifecycle).toContain('createSession');
    });

    it('mentions spawnAgent', () => {
      expect(lifecycle).toContain('spawnAgent');
    });

    it('mentions the agent plugin', () => {
      expect(lifecycle.toLowerCase()).toContain('agent plugin');
    });

    it('still fires onSessionStart (session id derived from taskId)', () => {
      expect(lifecycle).toContain('onSessionStart');
    });
  });

  // ── Lane-processing narrative (around line 273) ──────────────────────────

  describe('pool-processing narrative wording', () => {
    const section = extractBlock(guide, '### How `RunnerPool` processes a task');

    it('contains the "How RunnerPool processes a task" section', () => {
      expect(section).not.toBe('');
      expect(section).toContain('How `RunnerPool` processes a task');
    });

    it('does not reference createHarness', () => {
      expect(section).not.toContain('createHarness');
    });

    it('says "session" not "harness session"', () => {
      expect(section).toContain('session');
      expect(section).not.toContain('harness session');
    });

    it('references getRunnerForTask as the runner resolution', () => {
      expect(section).toContain('getRunnerForTask');
    });
  });

  // ── Testing guidance (around line 925) ────────────────────────────────────

  describe('testing guidance wording', () => {
    const bullet = extractBlock(guide, '**Mock the');

    it('contains a "Mock the …" bullet in the testing section', () => {
      expect(bullet).not.toBe('');
      expect(bullet).toContain('Mock the');
    });

    it('does not reference createHarness', () => {
      expect(bullet).not.toContain('createHarness');
    });

    it('references createSession as the seam', () => {
      expect(bullet).toContain('createSession');
    });

    it('references AgentRuntime', () => {
      expect(bullet).toContain('AgentRuntime');
    });

    it('references PromptableHarness', () => {
      expect(bullet).toContain('PromptableHarness');
    });

    it('references promptForStructured', () => {
      expect(bullet).toContain('promptForStructured');
    });
  });
});
