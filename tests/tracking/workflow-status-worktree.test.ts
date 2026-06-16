import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { WorktreeInfo } from '../../packages/engine/src/core/types.js';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

const SAMPLE_WORKTREE: WorktreeInfo = {
  worktreePath: '/tmp/worktree-abc123',
  branchName: 'feature/my-branch',
  originalCwd: '/home/user/project',
};

describe('WorkflowStatusTracker – worktree persistence', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── initial state ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('worktree getter returns undefined initially', () => {
      expect(tracker.worktree).toBeUndefined();
    });

    it('toJSON does not include worktree when not set', () => {
      const json = tracker.toJSON();
      // The field may be present as undefined or absent — both are acceptable
      if ('worktree' in json) {
        expect(json.worktree).toBeUndefined();
      }
    });
  });

  // ── setWorktree ────────────────────────────────────────────────────

  describe('setWorktree', () => {
    it('stores the worktree info', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const wt = tracker.worktree;
      expect(wt).toBeDefined();
      expect(wt!.worktreePath).toBe('/tmp/worktree-abc123');
      expect(wt!.branchName).toBe('feature/my-branch');
      expect(wt!.originalCwd).toBe('/home/user/project');
    });

    it('overwrites a previous worktree', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const updated: WorktreeInfo = {
        worktreePath: '/tmp/worktree-new',
        branchName: 'fix/bug-42',
        originalCwd: '/home/user/other',
      };
      tracker.setWorktree(updated);

      const wt = tracker.worktree;
      expect(wt!.worktreePath).toBe('/tmp/worktree-new');
      expect(wt!.branchName).toBe('fix/bug-42');
      expect(wt!.originalCwd).toBe('/home/user/other');
    });

    it('stores a defensive shallow copy (setWorktree input is not shared)', () => {
      const info: WorktreeInfo = { ...SAMPLE_WORKTREE };
      tracker.setWorktree(info);

      // Mutate the original object after setting
      info.worktreePath = '/changed';
      info.branchName = 'changed-branch';

      // The tracker should not be affected
      const wt = tracker.worktree;
      expect(wt!.worktreePath).toBe('/tmp/worktree-abc123');
      expect(wt!.branchName).toBe('feature/my-branch');
    });
  });

  // ── worktree getter ────────────────────────────────────────────────

  describe('worktree getter', () => {
    it('returns a shallow copy — mutations do not affect internal state', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const wt = tracker.worktree!;
      wt.worktreePath = '/mutated';
      wt.branchName = 'mutated-branch';

      // Internal state should be unchanged
      const wt2 = tracker.worktree!;
      expect(wt2.worktreePath).toBe('/tmp/worktree-abc123');
      expect(wt2.branchName).toBe('feature/my-branch');
    });

    it('returns undefined when no worktree has been set', () => {
      expect(tracker.worktree).toBeUndefined();
    });

    it('each call returns a fresh copy', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const a = tracker.worktree!;
      const b = tracker.worktree!;

      expect(a).toEqual(b);
      expect(a).not.toBe(b); // different object references
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────

  describe('toJSON', () => {
    it('includes worktree when set', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const json = tracker.toJSON();
      expect(json.worktree).toBeDefined();
      expect(json.worktree!.worktreePath).toBe('/tmp/worktree-abc123');
      expect(json.worktree!.branchName).toBe('feature/my-branch');
      expect(json.worktree!.originalCwd).toBe('/home/user/project');
    });

    it('returns worktree as undefined when not set', () => {
      const json = tracker.toJSON();
      if ('worktree' in json) {
        expect(json.worktree).toBeUndefined();
      }
    });

    it('worktree in JSON is a copy — mutations do not affect tracker', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const json = tracker.toJSON();
      json.worktree!.worktreePath = '/corrupted';
      json.worktree!.branchName = 'corrupted';

      // Tracker's internal state should be unaffected
      const wt = tracker.worktree!;
      expect(wt.worktreePath).toBe('/tmp/worktree-abc123');
      expect(wt.branchName).toBe('feature/my-branch');
    });
  });

  // ── save / load round-trip ─────────────────────────────────────────

  describe('save / load round-trip', () => {
    it('restores worktree through save and load', async () => {
      tracker.setTaskPrompt('worktree-test');
      tracker.setWorktree(SAMPLE_WORKTREE);

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const wt = restored.worktree;

      expect(wt).toBeDefined();
      expect(wt!.worktreePath).toBe('/tmp/worktree-abc123');
      expect(wt!.branchName).toBe('feature/my-branch');
      expect(wt!.originalCwd).toBe('/home/user/project');
    });

    it('restores worktree alongside other workflow state', async () => {
      tracker.setTaskPrompt('full-state');
      tracker.setPhase('implementing');
      tracker.addTokensToStats({ input: 200, output: 100 });
      tracker.incrementAgentCount();
      tracker.setWorktree({
        worktreePath: '/tmp/wt-full',
        branchName: 'main',
        originalCwd: '/project',
      });

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('full-state');
      expect(restored.currentPhaseId).toBe('implementing');
      expect(restored.stats).toEqual({ totalTokens: 300, totalCost: 0, agentCount: 1 });
      expect(restored.worktree).toBeDefined();
      expect(restored.worktree!.worktreePath).toBe('/tmp/wt-full');
      expect(restored.worktree!.branchName).toBe('main');
      expect(restored.worktree!.originalCwd).toBe('/project');
    });

    it('load returns undefined worktree when state file has no worktree field', async () => {
      // Simulate a legacy state file without worktree
      tracker.setTaskPrompt('legacy-no-worktree');
      await tracker.save();

      // Manually strip the worktree field from the JSON file
      const statePath = join(dir, '.engin-state.json');
      const raw = await fs.readFile(statePath, 'utf-8');
      const data = JSON.parse(raw);
      delete data.worktree;
      await fs.writeFile(statePath, JSON.stringify(data, null, 2), 'utf-8');

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.worktree).toBeUndefined();
      expect(restored.taskPrompt).toBe('legacy-no-worktree');
    });

    it('load returns undefined worktree when state file has worktree: null', async () => {
      tracker.setTaskPrompt('null-worktree');
      await tracker.save();

      const statePath = join(dir, '.engin-state.json');
      const raw = await fs.readFile(statePath, 'utf-8');
      const data = JSON.parse(raw);
      data.worktree = null;
      await fs.writeFile(statePath, JSON.stringify(data, null, 2), 'utf-8');

      const restored = await WorkflowStatusTracker.load(dir);
      // null is falsy, so `data.worktree ? ... : undefined` yields undefined
      expect(restored.worktree).toBeUndefined();
    });

    it('loaded worktree is a defensive copy independent of disk data', async () => {
      tracker.setWorktree(SAMPLE_WORKTREE);
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const wt = restored.worktree!;

      // Mutate the returned copy
      wt.worktreePath = '/mutated';

      // A fresh load should still have the original data
      const restored2 = await WorkflowStatusTracker.load(dir);
      expect(restored2.worktree!.worktreePath).toBe('/tmp/worktree-abc123');
    });

    it('overwrites worktree on second save/load cycle', async () => {
      tracker.setWorktree(SAMPLE_WORKTREE);
      await tracker.save();

      const first = await WorkflowStatusTracker.load(dir);
      expect(first.worktree!.branchName).toBe('feature/my-branch');

      first.setWorktree({
        worktreePath: '/tmp/new-wt',
        branchName: 'hotfix/urgent',
        originalCwd: '/home/user/project',
      });
      await first.save();

      const second = await WorkflowStatusTracker.load(dir);
      expect(second.worktree!.worktreePath).toBe('/tmp/new-wt');
      expect(second.worktree!.branchName).toBe('hotfix/urgent');
    });
  });

  // ── defensive copy verification ────────────────────────────────────

  describe('defensive copies', () => {
    it('get → mutate → get shows no side effects', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const first = tracker.worktree!;
      first.worktreePath = '/hacked';

      const second = tracker.worktree!;
      expect(second.worktreePath).toBe('/tmp/worktree-abc123');
    });

    it('toJSON → mutate → toJSON shows no side effects', () => {
      tracker.setWorktree(SAMPLE_WORKTREE);

      const json1 = tracker.toJSON();
      json1.worktree!.worktreePath = '/hacked';

      const json2 = tracker.toJSON();
      expect(json2.worktree!.worktreePath).toBe('/tmp/worktree-abc123');
    });

    it('setWorktree with same object reference stores a copy', () => {
      const info: WorktreeInfo = { ...SAMPLE_WORKTREE };
      tracker.setWorktree(info);
      // Mutate the input
      info.branchName = 'overwritten';

      expect(tracker.worktree!.branchName).toBe('feature/my-branch');
    });
  });

  // ── source code structural checks ──────────────────────────────────

  describe('source code structure', () => {
    it('imports WorktreeInfo from core types', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      const importLine = source.split('\n').find((line) => line.includes('../core/types.js'));
      expect(importLine).toBeDefined();
      expect(importLine!).toContain('WorktreeInfo');
    });

    it('has a _worktree private field', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      expect(source).toMatch(/private\s+_worktree\??\s*:\s*WorktreeInfo/);
    });

    it('has a worktree getter returning WorktreeInfo | undefined', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      expect(source).toMatch(/get\s+worktree\(\)[\s\S]*?WorktreeInfo\s*\|\s*undefined/);
    });

    it('has a setWorktree method accepting WorktreeInfo', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      expect(source).toMatch(/setWorktree\(info\s*:\s*WorktreeInfo\)/);
    });

    it('setWorktree uses spread copy', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      // Find the setWorktree method body
      const setWorktreeIdx = source.indexOf('setWorktree(');
      expect(setWorktreeIdx).toBeGreaterThan(-1);

      const methodBody = source.slice(setWorktreeIdx, source.indexOf('}', setWorktreeIdx) + 1);
      expect(methodBody).toMatch(/\{\s*\.\.\.\s*info\s*\}/);
    });

    it('serializeWorkflowState includes worktree with spread copy', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-serializer.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      // serializeWorkflowState should contain worktree: tracker.worktree
      // The getter already returns a defensive copy, so the serializer uses it directly
      expect(source).toMatch(/worktree\s*:\s*tracker\.worktree/);
    });

    it('load() restores _worktree from data.worktree with spread copy', async () => {
      const sourcePath = join(
        import.meta.dir,
        '..',
        '..',
        'packages',
        'engine',
        'src',
        'tracking',
        'workflow-status.ts',
      );
      const source = await fs.readFile(sourcePath, 'utf-8');

      // load() should have: tracker._worktree = data.worktree ? { ...data.worktree } : undefined
      expect(source).toMatch(
        /tracker\._worktree\s*=\s*data\.worktree\s*\?\s*\{\s*\.\.\.\s*data\.worktree\s*\}\s*:\s*undefined/,
      );
    });

    it('WorktreeInfo is in the WorkflowState interface', async () => {
      const typesPath = join(import.meta.dir, '..', '..', 'packages', 'engine', 'src', 'core', 'types.ts');
      const source = await fs.readFile(typesPath, 'utf-8');

      // WorkflowState should have a worktree field
      expect(source).toMatch(/worktree\??\s*:\s*WorktreeInfo/);
    });

    it('WorktreeInfo interface has required fields', async () => {
      const typesPath = join(import.meta.dir, '..', '..', 'packages', 'engine', 'src', 'core', 'types.ts');
      const source = await fs.readFile(typesPath, 'utf-8');

      // Find the WorktreeInfo interface
      const wtIdx = source.indexOf('interface WorktreeInfo');
      expect(wtIdx).toBeGreaterThan(-1);

      const iface = source.slice(wtIdx, source.indexOf('}', wtIdx) + 1);
      expect(iface).toContain('worktreePath');
      expect(iface).toContain('branchName');
      expect(iface).toContain('originalCwd');
    });
  });
});
