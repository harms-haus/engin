import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WorkflowStatusTracker } from '../../src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('WorkflowStatusTracker', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── initial state ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with default values', () => {
      expect(tracker.taskPrompt).toBe('');
      expect(tracker.currentPhase).toBe('scouting');
      expect(tracker.completedPhases).toEqual([]);
      expect(tracker.scoutingReports).toEqual([]);
      expect(tracker.plan).toBeUndefined();
      expect(tracker.stats).toEqual({ totalTokens: 0, totalCost: 0, agentCount: 0 });
    });

    it('exposes a taskTracker instance', () => {
      expect(tracker.taskTracker).toBeDefined();
      expect(tracker.taskTracker.getAllTasks()).toEqual([]);
    });

    it('exposes an auditLog instance', () => {
      expect(tracker.auditLog).toBeDefined();
    });
  });

  // ── setTaskPrompt ──────────────────────────────────────────────────

  describe('setTaskPrompt', () => {
    it('stores the prompt', () => {
      tracker.setTaskPrompt('Build a web app');
      expect(tracker.taskPrompt).toBe('Build a web app');
    });

    it('overwrites previous prompt', () => {
      tracker.setTaskPrompt('first');
      tracker.setTaskPrompt('second');
      expect(tracker.taskPrompt).toBe('second');
    });
  });

  // ── advancePhase ───────────────────────────────────────────────────

  describe('advancePhase', () => {
    it('advances through each phase in order', () => {
      const expectedOrder = ['scouting_review', 'planning', 'plan_review', 'implementing', 'final_review', 'done'];

      for (const expected of expectedOrder) {
        tracker.advancePhase();
        expect(tracker.currentPhase).toBe(expected);
      }
    });

    it('tracks completed phases', () => {
      tracker.advancePhase();
      expect(tracker.completedPhases).toEqual(['scouting']);

      tracker.advancePhase();
      expect(tracker.completedPhases).toEqual(['scouting', 'scouting_review']);
    });

    it('completedPhases getter returns a copy', () => {
      tracker.advancePhase();
      const phases = tracker.completedPhases;
      phases.push('fake' as never);
      expect(tracker.completedPhases).toEqual(['scouting']);
    });

    it('throws when already at the final phase', () => {
      // Advance to done
      for (let i = 0; i < 6; i++) {
        tracker.advancePhase();
      }
      expect(tracker.currentPhase).toBe('done');
      expect(() => tracker.advancePhase()).toThrow('already at the final phase');
    });
  });

  // ── setPhase ───────────────────────────────────────────────────────

  describe('setPhase', () => {
    it('allows setting a valid phase', () => {
      tracker.setPhase('implementing');
      expect(tracker.currentPhase).toBe('implementing');
    });

    it('throws for an invalid phase string', () => {
      expect(() => tracker.setPhase('invalid' as never)).toThrow('Invalid phase');
    });

    it('allows jumping to any valid phase (for restore)', () => {
      tracker.setPhase('done');
      expect(tracker.currentPhase).toBe('done');

      tracker.setPhase('scouting');
      expect(tracker.currentPhase).toBe('scouting');
    });
  });

  // ── setScoutingReports ─────────────────────────────────────────────

  describe('setScoutingReports', () => {
    it('stores the reports', () => {
      const reports = [{ summary: 'found issues' }, { summary: 'all clear' }];
      tracker.setScoutingReports(reports);
      expect(tracker.scoutingReports).toEqual(reports);
    });

    it('overwrites previous reports', () => {
      tracker.setScoutingReports([{ a: 1 }]);
      tracker.setScoutingReports([{ b: 2 }]);
      expect(tracker.scoutingReports).toEqual([{ b: 2 }]);
    });
  });

  // ── setPlan ────────────────────────────────────────────────────────

  describe('setPlan', () => {
    it('stores the plan', () => {
      const plan = { tasks: ['t1', 't2'], estimate: '2h' };
      tracker.setPlan(plan);
      expect(tracker.plan).toEqual(plan);
    });

    it('overwrites previous plan', () => {
      tracker.setPlan({ version: 1 });
      tracker.setPlan({ version: 2 });
      expect(tracker.plan).toEqual({ version: 2 });
    });
  });

  // ── stats mutators ─────────────────────────────────────────────────

  describe('stats mutators', () => {
    it('addTokensToStats accumulates tokens', () => {
      tracker.addTokensToStats({ input: 100, output: 50 });
      expect(tracker.stats.totalTokens).toBe(150);

      tracker.addTokensToStats({ input: 200, output: 100 });
      expect(tracker.stats.totalTokens).toBe(450);
    });

    it('incrementAgentCount increments by 1', () => {
      tracker.incrementAgentCount();
      expect(tracker.stats.agentCount).toBe(1);

      tracker.incrementAgentCount();
      expect(tracker.stats.agentCount).toBe(2);
    });

    it('stats getter returns a copy', () => {
      tracker.incrementAgentCount();
      const stats = tracker.stats;
      stats.agentCount = 999;
      expect(tracker.stats.agentCount).toBe(1);
    });
  });

  // ── planReviewFeedback ────────────────────────────────────────────

  describe('planReviewFeedback', () => {
    it('getters return undefined initially', () => {
      expect(tracker.planReviewFeedback).toBeUndefined();
      expect(tracker.planReviewSuggestions).toBeUndefined();
    });

    it('setPlanReviewFeedback stores both feedback and suggestions', () => {
      tracker.setPlanReviewFeedback('Missing error handling', ['Add try/catch']);
      expect(tracker.planReviewFeedback).toBe('Missing error handling');
      expect(tracker.planReviewSuggestions).toEqual(['Add try/catch']);
    });

    it('planReviewSuggestions getter returns a defensive copy', () => {
      tracker.setPlanReviewFeedback('Needs improvement', ['s1', 's2']);
      const suggestions = tracker.planReviewSuggestions;
      suggestions!.push('s3');
      expect(tracker.planReviewSuggestions).toEqual(['s1', 's2']);
    });

    it('clearPlanReviewFeedback resets both to undefined', () => {
      tracker.setPlanReviewFeedback('Feedback', ['Suggestion']);
      tracker.clearPlanReviewFeedback();
      expect(tracker.planReviewFeedback).toBeUndefined();
      expect(tracker.planReviewSuggestions).toBeUndefined();
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────

  describe('toJSON', () => {
    it('returns a complete WorkflowState object', () => {
      tracker.setTaskPrompt('my prompt');
      tracker.setScoutingReports([{ note: 'hello' }]);
      tracker.setPlan({ steps: [1, 2, 3] });
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();

      const json = tracker.toJSON();

      expect(json.taskPrompt).toBe('my prompt');
      expect(json.currentPhase).toBe('scouting');
      expect(json.completedPhases).toEqual([]);
      expect(json.scoutingReports).toEqual([{ note: 'hello' }]);
      expect(json.plan).toEqual({ steps: [1, 2, 3] });
      expect(json.stats).toEqual({ totalTokens: 150, totalCost: 0, agentCount: 1 });
      expect(json.tasks).toEqual([]);
    });

    it('includes planReviewFeedback fields when set', () => {
      tracker.setPlanReviewFeedback('Missing error handling', ['Add try/catch']);

      const json = tracker.toJSON();

      expect(json.planReviewFeedback).toBe('Missing error handling');
      expect(json.planReviewSuggestions).toEqual(['Add try/catch']);
    });

    it('includes tasks from the taskTracker', () => {
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      const json = tracker.toJSON();
      expect(json.tasks).toHaveLength(1);
      expect(json.tasks[0].id).toBe('t1');
    });

    it('stats getter returns independent copy', () => {
      const json = tracker.toJSON();
      json.stats.totalTokens = 999;
      expect(tracker.toJSON().stats.totalTokens).toBe(0);
    });
  });

  // ── save / load round-trip ─────────────────────────────────────────

  describe('save / load round-trip', () => {
    it('restores all fields through save and load', async () => {
      tracker.setTaskPrompt('Build something great');
      tracker.setScoutingReports([{ summary: 'report 1' }, { summary: 'report 2' }]);
      tracker.setPlan({ phases: ['a', 'b', 'c'] });
      tracker.addTokensToStats({ input: 500, output: 250 });
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();
      tracker.incrementAgentCount();

      // Advance two phases
      tracker.advancePhase(); // → scouting_review
      tracker.advancePhase(); // → planning

      // Add a task
      tracker.taskTracker.addTask(makeTask({ id: 'task-a' }));
      tracker.taskTracker.addTask({ ...makeTask({ id: 'task-b', dependencies: ['task-a'] }), status: undefined });

      await tracker.save();

      // Load into a new tracker
      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.taskPrompt).toBe('Build something great');
      expect(restored.currentPhase).toBe('planning');
      expect(restored.completedPhases).toEqual(['scouting', 'scouting_review']);
      expect(restored.scoutingReports).toEqual([{ summary: 'report 1' }, { summary: 'report 2' }]);
      expect(restored.plan).toEqual({ phases: ['a', 'b', 'c'] });
      expect(restored.stats).toEqual({
        totalTokens: 900,
        totalCost: 0,
        agentCount: 2,
      });

      // TaskTracker was rebuilt
      expect(restored.taskTracker.getAllTasks()).toHaveLength(2);
      expect(restored.taskTracker.getTask('task-a')!.status).toBe('ready');
      expect(restored.taskTracker.getTask('task-b')!.status).toBe('blocked');
    });

    it('restores planReviewFeedback through save and load', async () => {
      tracker.setPlanReviewFeedback('Build error handling', ['Add try/catch']);

      await tracker.save();
      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.planReviewFeedback).toBe('Build error handling');
      expect(restored.planReviewSuggestions).toEqual(['Add try/catch']);
    });

    it("save creates the workDir if it doesn't exist", async () => {
      const nestedDir = path.join(dir, 'nested', 'deep');
      const nestedTracker = new WorkflowStatusTracker(nestedDir);
      nestedTracker.setTaskPrompt('nested');

      await nestedTracker.save();

      const raw = await fs.readFile(path.join(nestedDir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('nested');
    });

    it('load throws when file does not exist', async () => {
      await expect(WorkflowStatusTracker.load(path.join(dir, 'nonexistent'))).rejects.toThrow(
        'Workflow state file not found',
      );
    });

    it('round-trip preserves task lifecycle states', async () => {
      tracker.taskTracker.addTask(makeTask({ id: 'a' }));
      tracker.taskTracker.addTask(makeTask({ id: 'b', dependencies: ['a'] }));

      // Complete task a
      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('a', 'agent-1');
      tracker.taskTracker.submitForReview('a', { done: true });
      tracker.taskTracker.completeTask('a');

      await tracker.save();
      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.taskTracker.getTask('a')!.status).toBe('done');
      expect(restored.taskTracker.getTask('b')!.status).toBe('ready');
    });

    it('restored tracker is independent of the original', async () => {
      tracker.setTaskPrompt('original');
      await tracker.save();

      tracker.setTaskPrompt('modified');
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('modified');

      restored.setTaskPrompt('loaded-value');
      const reloaded = await WorkflowStatusTracker.load(dir);
      expect(reloaded.taskPrompt).toBe('modified'); // save wasn't called on restored
    });
  });

  // ── auto-persist on task settlement ────────────────────────────────

  describe('auto-persist on task settlement', () => {
    it('completeTask triggers auto-persist to disk', async () => {
      tracker.setTaskPrompt('auto-persist-test');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('t1', 'agent-x');
      tracker.taskTracker.submitForReview('t1', { ok: true });
      tracker.taskTracker.completeTask('t1');

      // Allow the fire-and-forget save() promise to settle
      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('done');
      expect(restored.taskPrompt).toBe('auto-persist-test');
    });

    it('failTask triggers auto-persist to disk', async () => {
      tracker.setTaskPrompt('fail-persist-test');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('t1', 'agent-x');
      tracker.taskTracker.failTask('t1', { error: 'boom' });

      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('failed');
      expect(restored.taskPrompt).toBe('fail-persist-test');
    });

    it('auto-persist works after load() (resume scenario)', async () => {
      // Save a tracker with a ready task
      tracker.setTaskPrompt('resume-test');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));
      await tracker.save();

      // Load it — this should re-attach the auto-persist listener
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('ready');

      // Run the full lifecycle on the loaded tracker
      const _claimed = restored.taskTracker.claimTasks(1);
      restored.taskTracker.startTask('t1', 'agent-x');
      restored.taskTracker.submitForReview('t1', { ok: true });
      restored.taskTracker.completeTask('t1');

      await new Promise((r) => setTimeout(r, 50));

      // Reload from disk — should reflect the completed task
      const reloaded = await WorkflowStatusTracker.load(dir);
      expect(reloaded.taskTracker.getTask('t1')!.status).toBe('done');
    });

    it('auto-persist does not throw on disk error', async () => {
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      // Override save to simulate a disk error
      const originalSave = tracker.save.bind(tracker);
      let saveWasCalled = false;
      tracker.save = async () => {
        saveWasCalled = true;
        throw new Error('Simulated disk write failure');
      };

      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('t1', 'agent-x');
      tracker.taskTracker.submitForReview('t1', { ok: true });

      // completeTask should not throw — save() is fire-and-forget with .catch()
      tracker.taskTracker.completeTask('t1');

      // Wait for the fire-and-forget save attempt to settle
      await new Promise((r) => setTimeout(r, 50));

      // In-memory state is still correct despite the save failure
      expect(tracker.taskTracker.getTask('t1')!.status).toBe('done');
      expect(saveWasCalled).toBe(true);

      // Restore original save method for cleanup
      tracker.save = originalSave;
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('advancePhase works from a non-default starting point', () => {
      tracker.setPhase('plan_review');
      tracker.advancePhase();
      expect(tracker.currentPhase).toBe('implementing');
    });

    it('completedPhases only tracks advances, not setPhase jumps', () => {
      tracker.setPhase('implementing');
      // completedPhases should still be empty since we jumped, not advanced
      expect(tracker.completedPhases).toEqual([]);

      tracker.advancePhase();
      expect(tracker.currentPhase).toBe('final_review');
      // Only the most recent advance is tracked
      expect(tracker.completedPhases).toEqual(['implementing']);
    });

    it('auditLog points to workDir/audit', async () => {
      // Append an event and verify the file is created at the right path
      await tracker.auditLog.append({
        type: 'agent_start',
        agentId: 'test-agent',
        profile: {} as never,
      });

      const auditPath = path.join(dir, 'audit', 'audit.jsonl');
      const content = await fs.readFile(auditPath, 'utf-8');
      const record = JSON.parse(content.trim());
      expect(record.agentId).toBe('test-agent');
    });

    it('save and load with empty task list', async () => {
      tracker.setTaskPrompt('minimal');
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('minimal');
      expect(restored.taskTracker.getAllTasks()).toEqual([]);
    });

    it('setPlan with complex nested data survives round-trip', async () => {
      const complexPlan = {
        tasks: [
          { id: 't1', files: ['a.ts', 'b.ts'] },
          { id: 't2', files: ['c.ts'] },
        ],
        metadata: { version: 2, author: 'test' },
      };
      tracker.setPlan(complexPlan);
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.plan).toEqual(complexPlan);
    });
  });
});
