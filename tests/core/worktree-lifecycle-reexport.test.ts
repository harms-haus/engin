import { describe, expect, it } from 'bun:test';
// Import from the barrel (index.ts) to verify worktree-lifecycle.ts is re-exported
import { generateCommitMessage, pushAndCreatePR, resolveConflictsWithAgent, setupWorktree } from '../../src/index.js';

describe('worktree-lifecycle module re-export from index.ts', () => {
  it('re-exports setupWorktree as a function', () => {
    expect(typeof setupWorktree).toBe('function');
  });

  it('re-exports generateCommitMessage as a function', () => {
    expect(typeof generateCommitMessage).toBe('function');
  });

  it('re-exports resolveConflictsWithAgent as a function', () => {
    expect(typeof resolveConflictsWithAgent).toBe('function');
  });

  it('re-exports pushAndCreatePR as a function', () => {
    expect(typeof pushAndCreatePR).toBe('function');
  });
});
