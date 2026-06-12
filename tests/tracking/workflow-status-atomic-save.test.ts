import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowStatusTracker } from '../../src/tracking/workflow-status.js';
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

  // ── temp file cleanup ─────────────────────────────────────────────

  describe('temp file cleanup', () => {
    it('leaves no .tmp file after save completes', async () => {
      tracker.setTaskPrompt('no-residue');
      await tracker.save();

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    it('does not leave a .tmp file after multiple saves', async () => {
      tracker.setTaskPrompt('first');
      await tracker.save();

      tracker.setTaskPrompt('second');
      await tracker.save();

      tracker.setTaskPrompt('third');
      await tracker.save();

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });
  });

  // ── final file correctness ─────────────────────────────────────────

  describe('final file correctness', () => {
    it('writes correct data to .engin-state.json after atomic rename', async () => {
      tracker.setTaskPrompt('atomic-test');
      tracker.addTokensToStats({ input: 42, output: 7 });

      await tracker.save();

      const finalPath = join(dir, '.engin-state.json');
      const raw = await fs.readFile(finalPath, 'utf-8');
      const data = JSON.parse(raw);

      expect(data.taskPrompt).toBe('atomic-test');
      expect(data.stats.totalTokens).toBe(49);
    });

    it('overwrites previous state correctly on subsequent saves', async () => {
      tracker.setTaskPrompt('version-1');
      await tracker.save();

      tracker.setTaskPrompt('version-2');
      await tracker.save();

      const finalPath = join(dir, '.engin-state.json');
      const raw = await fs.readFile(finalPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('version-2');
    });

    it('preserves all fields through atomic save and load', async () => {
      tracker.setTaskPrompt('full-round-trip');
      tracker.setPhase('scouting');
      tracker.setPhase('implementing');
      tracker.setPlan({ steps: ['a', 'b'] });
      tracker.setResearch('some research notes');
      tracker.setPlanReviewFeedback('needs work', ['suggestion 1']);
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();
      tracker.taskTracker.addTask(makeTask({ id: 'task-1' }));
      tracker.recordAgentSpawn('agent-1', 'coder', 'implementing', 'task-1');

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.taskPrompt).toBe('full-round-trip');
      expect(restored.currentPhase).toBe('implementing');
      expect(restored.completedPhases).toEqual(['scouting']);
      expect(restored.plan).toEqual({ steps: ['a', 'b'] });
      expect(restored.research).toBe('some research notes');
      expect(restored.planReviewFeedback).toBe('needs work');
      expect(restored.planReviewSuggestions).toEqual(['suggestion 1']);
      expect(restored.stats.totalTokens).toBe(150);
      expect(restored.stats.agentCount).toBe(1);
      expect(restored.taskTracker.getAllTasks()).toHaveLength(1);
      expect(restored.spawnedAgents).toHaveLength(1);
      expect(restored.spawnedAgents[0].agentId).toBe('agent-1');
    });
  });

  // ── atomic write pattern verification via source inspection ────────

  describe('source code structure', () => {
    it('imports rename from node:fs/promises', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // Should import rename from node:fs/promises
      expect(source).toMatch(/import\s*\{[^}]*,\s*rename\s*,?[^}]*\}\s*from\s*['"]node:fs\/promises['"]/);
    });

    it('save method writes to tmp file then renames', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // Extract the save method body
      const saveMatch = source.match(/async\s+save\s*\(\s*\)\s*:\s*Promise<void>\s*\{[\s\S]*?^\s{2}\}/m);
      expect(saveMatch).not.toBeNull();
      const saveBody = saveMatch![0];

      // Should define a tmpPath variable
      expect(saveBody).toContain('.engin-state.json.tmp');

      // Should write to tmpPath first
      expect(saveBody).toMatch(/writeFile\(tmpPath/);

      // Should rename tmpPath to filePath as the final step
      expect(saveBody).toMatch(/rename\(tmpPath,\s*filePath\)/);
    });

    it('does not write directly to the final file path', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      const saveMatch = source.match(/async\s+save\s*\(\s*\)\s*:\s*Promise<void>\s*\{[\s\S]*?^\s{2}\}/m);
      expect(saveMatch).not.toBeNull();
      const saveBody = saveMatch![0];

      // The save method should NOT write directly to filePath (the old pattern)
      // The old pattern was: await writeFile(filePath, ...)
      // The new pattern writes to tmpPath first
      expect(saveBody).not.toMatch(/await\s+writeFile\(filePath,/);
    });
  });

  // ── auto-persist with atomic writes ────────────────────────────────

  describe('auto-persist uses atomic writes', () => {
    it('auto-persist from task settlement leaves no .tmp residue', async () => {
      tracker.setTaskPrompt('auto-atomic');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('t1', 'agent-x');
      tracker.taskTracker.submitForReview('t1', { ok: true });
      tracker.taskTracker.completeTask('t1');

      // Allow the fire-and-forget save() promise to settle
      await new Promise((r) => setTimeout(r, 100));

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // And the final state should be correct
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('done');
      expect(restored.taskPrompt).toBe('auto-atomic');
    });

    it('auto-persist from recordAgentSpawn leaves no .tmp residue', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      await new Promise((r) => setTimeout(r, 100));

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toHaveLength(1);
    });

    it('auto-persist from setSidebar leaves no .tmp residue', async () => {
      tracker.setSidebar({ title: 'My Workflow', indicator: 'running' });

      await new Promise((r) => setTimeout(r, 100));

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.sidebar?.title).toBe('My Workflow');
      expect(restored.sidebar?.indicator).toBe('running');
    });
  });

  // ── no stale tmp files on overwrite ────────────────────────────────

  describe('overwrite scenarios', () => {
    it('does not leave stale .tmp file when overwriting existing state', async () => {
      // First save
      tracker.setTaskPrompt('first');
      await tracker.save();

      // Verify state file exists
      const finalPath = join(dir, '.engin-state.json');
      const tmpPath = join(dir, '.engin-state.json.tmp');
      const raw1 = await fs.readFile(finalPath, 'utf-8');
      expect(JSON.parse(raw1).taskPrompt).toBe('first');

      // Second save (overwrites)
      tracker.setTaskPrompt('second');
      await tracker.save();

      // No tmp residue
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // Final file updated
      const raw2 = await fs.readFile(finalPath, 'utf-8');
      expect(JSON.parse(raw2).taskPrompt).toBe('second');
    });

    it('rapid consecutive saves all complete atomically', async () => {
      // Fire multiple saves in parallel
      const saves: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        tracker.setTaskPrompt(`rapid-${i}`);
        saves.push(tracker.save());
      }
      await Promise.all(saves);

      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // The final file should have one of the prompts (last to complete)
      const finalPath = join(dir, '.engin-state.json');
      const raw = await fs.readFile(finalPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toMatch(/^rapid-\d+$/);
    });
  });

  // ── directory creation still works with atomic pattern ─────────────

  describe('directory creation', () => {
    it('creates nested directories before atomic write', async () => {
      const nestedDir = join(dir, 'deep', 'nested', 'path');
      const nestedTracker = new WorkflowStatusTracker(nestedDir);
      nestedTracker.setTaskPrompt('nested-atomic');

      await nestedTracker.save();

      // No tmp residue
      const tmpPath = join(nestedDir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // Final file correct
      const finalPath = join(nestedDir, '.engin-state.json');
      const raw = await fs.readFile(finalPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('nested-atomic');
    });
  });
});
