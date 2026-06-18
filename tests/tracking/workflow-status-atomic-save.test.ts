import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('WorkflowStatusTracker – atomic save', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── temp file lifecycle ──────────────────────────────────────────

  describe('temp file lifecycle', () => {
    it('no temp file remains after save() completes', async () => {
      tracker.setTaskPrompt('temp-file-check');
      await tracker.save();

      const statePath = join(dir, '.engin-state.json');
      const tmpPath = join(dir, '.engin-state.json.tmp');

      // Main state file should exist
      const stateContent = await fs.readFile(statePath, 'utf-8');
      const data = JSON.parse(stateContent);
      expect(data.taskPrompt).toBe('temp-file-check');

      // Temp file must not linger
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    it('temp file is cleaned up even after multiple consecutive saves', async () => {
      tracker.setTaskPrompt('first');
      await tracker.save();

      tracker.setTaskPrompt('second');
      await tracker.save();

      tracker.setTaskPrompt('third');
      await tracker.save();

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // Only the final state should be on disk
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('third');
    });
  });

  // ── atomic write via rename ──────────────────────────────────────

  describe('atomic write via rename', () => {
    it('save produces a valid state file that loads correctly', async () => {
      tracker.setTaskPrompt('atomic-verify');
      tracker.setWorkflowData({ plan: { steps: ['a', 'b'] } });
      tracker.addTokensToStats({ input: 42, output: 7 });
      tracker.incrementAgentCount();
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('atomic-verify');
      const restoredData = restored.workflowData as Record<string, unknown>;
      expect(restoredData.plan).toEqual({ steps: ['a', 'b'] });
      expect(restored.stats.totalTokens).toBe(49);
      expect(restored.stats.agentCount).toBe(1);
      expect(restored.taskTracker.getAllTasks()).toHaveLength(1);
    });

    it('rename overwrites previous state file completely', async () => {
      // First save with one set of data
      tracker.setTaskPrompt('version-1');
      tracker.setWorkflowData({ plan: { v: 1 } });
      await tracker.save();

      // Verify first version
      let restored = await WorkflowStatusTracker.load(dir);
      expect((restored.workflowData as Record<string, unknown>).plan).toEqual({ v: 1 });

      // Second save with different data
      tracker.setWorkflowData({ plan: { v: 2, extra: true } });
      await tracker.save();

      // Verify second version replaces first entirely
      restored = await WorkflowStatusTracker.load(dir);
      expect((restored.workflowData as Record<string, unknown>).plan).toEqual({ v: 2, extra: true });
      expect(restored.taskPrompt).toBe('version-1');
    });

    it('save works correctly when no prior state file exists', async () => {
      // Fresh directory — no .engin-state.json at all
      await expect(fs.access(join(dir, '.engin-state.json'))).rejects.toThrow();

      tracker.setTaskPrompt('fresh-save');
      await tracker.save();

      // File should now exist and be valid
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('fresh-save');
    });

    it('save works when temp file already exists from a previous failed write', async () => {
      // Simulate a leftover temp file from a crashed previous run
      const tmpPath = join(dir, '.engin-state.json.tmp');
      await fs.writeFile(tmpPath, 'stale content', 'utf-8');

      tracker.setTaskPrompt('overwrite-stale-tmp');
      await tracker.save();

      // Temp file should be cleaned up
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // State file should have the new content
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('overwrite-stale-tmp');
    });
  });

  // ── data integrity after atomic save ─────────────────────────────

  describe('data integrity', () => {
    it('round-trip preserves all field types through atomic write', async () => {
      tracker.setTaskPrompt('integrity-test');
      tracker.setWorkflowData({
        scoutingReports: [{ a: 1 }, { b: [2, 3] }],
        plan: { nested: { deep: true } },
        research: 'some research notes',
        planReviewFeedback: 'looks good',
        planReviewSuggestions: ['suggestion-1'],
      });
      tracker.setCurrentPhase('implementing');
      tracker.addTokensToStats({ input: 100, output: 200 });
      tracker.incrementAgentCount();
      tracker.incrementAgentCount();
      tracker.taskTracker.addTask(makeTask({ id: 'task-integrity' }));

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const restoredData = restored.workflowData as Record<string, unknown>;
      expect(restored.taskPrompt).toBe('integrity-test');
      expect(restoredData.scoutingReports).toEqual([{ a: 1 }, { b: [2, 3] }]);
      expect(restoredData.plan).toEqual({ nested: { deep: true } });
      expect(restoredData.research).toBe('some research notes');
      expect(restoredData.planReviewFeedback).toBe('looks good');
      expect(restoredData.planReviewSuggestions).toEqual(['suggestion-1']);
      expect(restored.currentPhaseId).toBe('implementing');
      expect(restored.stats).toEqual({ totalTokens: 300, totalCost: 0, agentCount: 2 });
      expect(restored.taskTracker.getAllTasks()).toHaveLength(1);
      expect(restored.taskTracker.getTask('task-integrity')!.id).toBe('task-integrity');
    });

    it('auto-persist via task lifecycle uses atomic save', async () => {
      tracker.setTaskPrompt('auto-atomic');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      tracker.taskTracker.claimTasks(1, 'agent-1');
      tracker.taskTracker.completeTask('t1');

      await tracker.save();

      // No temp file should remain
      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // State file should have correct content
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('complete');
      expect(restored.taskPrompt).toBe('auto-atomic');
    });

    it('save in nested directory creates correct paths for temp and final', async () => {
      const nestedDir = join(dir, 'deep', 'nested', 'path');
      const nestedTracker = new WorkflowStatusTracker(nestedDir);
      nestedTracker.setTaskPrompt('nested-atomic');

      await nestedTracker.save();

      // State file should be in nested dir
      const statePath = join(nestedDir, '.engin-state.json');
      const tmpPath = join(nestedDir, '.engin-state.json.tmp');

      const raw = await fs.readFile(statePath, 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('nested-atomic');

      // No temp file
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });
  });

  // ── concurrency / rapid saves ────────────────────────────────────

  describe('concurrent saves', () => {
    it('rapid sequential saves all complete without leaving temp files', async () => {
      for (let i = 0; i < 10; i++) {
        tracker.setTaskPrompt(`rapid-${i}`);
        await tracker.save();
      }

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('rapid-9');
    });

    it('concurrent saves resolve to a consistent state', async () => {
      // Fire multiple saves concurrently
      const saves = [];
      for (let i = 0; i < 5; i++) {
        tracker.setTaskPrompt(`concurrent-${i}`);
        saves.push(tracker.save());
      }
      await Promise.all(saves);

      // Temp file should be gone (last rename wins)
      // One of the concurrent writes may leave a tmp if they interleave,
      // but the state file must be valid JSON either way
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toMatch(/^concurrent-\d$/);
    });
  });
});
