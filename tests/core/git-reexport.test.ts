import { describe, expect, it } from 'bun:test';
// Import from the barrel (index.ts) to verify git.ts is re-exported
import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  copyFilesToWorktree,
  createWorktree,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  getRepoRoot,
  isGitRepo,
  listConflictedFiles,
  mergeBranch,
  pushBranch,
  readWorktreeCopyList,
  removeWorktree,
  stageAll,
} from '../../src/index.js';

describe('git module re-export from index.ts', () => {
  it('re-exports isGitRepo as a function', () => {
    expect(typeof isGitRepo).toBe('function');
  });

  it('re-exports getRepoRoot as a function', () => {
    expect(typeof getRepoRoot).toBe('function');
  });

  it('re-exports getCurrentBranch as a function', () => {
    expect(typeof getCurrentBranch).toBe('function');
  });

  it('re-exports getMainBranch as a function', () => {
    expect(typeof getMainBranch).toBe('function');
  });

  it('re-exports createWorktree as a function', () => {
    expect(typeof createWorktree).toBe('function');
  });

  it('re-exports removeWorktree as a function', () => {
    expect(typeof removeWorktree).toBe('function');
  });

  it('re-exports listConflictedFiles as a function', () => {
    expect(typeof listConflictedFiles).toBe('function');
  });

  it('re-exports stageAll as a function', () => {
    expect(typeof stageAll).toBe('function');
  });

  it('re-exports commitChanges as a function', () => {
    expect(typeof commitChanges).toBe('function');
  });

  it('re-exports checkoutBranch as a function', () => {
    expect(typeof checkoutBranch).toBe('function');
  });

  it('re-exports mergeBranch as a function', () => {
    expect(typeof mergeBranch).toBe('function');
  });

  it('re-exports abortMerge as a function', () => {
    expect(typeof abortMerge).toBe('function');
  });

  it('re-exports pushBranch as a function', () => {
    expect(typeof pushBranch).toBe('function');
  });

  it('re-exports getDiff as a function', () => {
    expect(typeof getDiff).toBe('function');
  });

  it('re-exports readWorktreeCopyList as a function', () => {
    expect(typeof readWorktreeCopyList).toBe('function');
  });

  it('re-exports copyFilesToWorktree as a function', () => {
    expect(typeof copyFilesToWorktree).toBe('function');
  });
});
