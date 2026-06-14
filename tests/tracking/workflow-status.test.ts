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
      expect(tracker.currentPhaseId).toBe('');
      expect(tracker.completedPhaseIds).toEqual([]);
      expect(tracker.workflowData).toEqual({});
      expect((tracker.workflowData as Record<string, unknown>).scoutingReports).toBeUndefined();
      expect((tracker.workflowData as Record<string, unknown>).plan).toBeUndefined();
      expect(tracker.stats).toEqual({ totalTokens: 0, totalCost: 0, agentCount: 0 });
    });

    it('exposes a taskTracker instance', () => {
      expect(tracker.taskTracker).toBeDefined();
      expect(tracker.taskTracker.getAllTasks()).toEqual([]);
    });

    it('exposes an auditLog instance', () => {
      expect(tracker.auditLog).toBeDefined();
    });

    it('phases getter returns empty array initially', () => {
      expect(tracker.phases).toEqual([]);
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

  // ── setPhase ───────────────────────────────────────────────────────

  describe('setPhase', () => {
    it('pushes current phase to completedPhaseIds and sets new phase', () => {
      tracker.setCurrentPhase('scouting');
      tracker.setPhase('planning');
      expect(tracker.currentPhaseId).toBe('planning');
      expect(tracker.completedPhaseIds).toEqual(['scouting']);
    });

    it('chains multiple transitions', () => {
      tracker.setCurrentPhase('scouting');
      tracker.setPhase('planning');
      tracker.setPhase('implementing');
      tracker.setPhase('review');
      expect(tracker.currentPhaseId).toBe('review');
      expect(tracker.completedPhaseIds).toEqual(['scouting', 'planning', 'implementing']);
    });

    it('accepts any string — no validation', () => {
      expect(() => tracker.setPhase('custom-phase')).not.toThrow();
      expect(tracker.currentPhaseId).toBe('custom-phase');
    });

    it('does not push empty string to completedPhaseIds', () => {
      // Fresh tracker has currentPhaseId="", so setPhase should skip pushing it
      tracker.setPhase('scouting');
      expect(tracker.completedPhaseIds).toEqual([]);
      expect(tracker.currentPhaseId).toBe('scouting');
    });
  });

  // ── setCurrentPhase ─────────────────────────────────────────────────

  describe('setCurrentPhase', () => {
    it('sets the current phase without pushing to completedPhaseIds', () => {
      tracker.setCurrentPhase('scouting');
      expect(tracker.currentPhaseId).toBe('scouting');
      expect(tracker.completedPhaseIds).toEqual([]);
    });

    it('overwrites the current phase without history', () => {
      tracker.setCurrentPhase('scouting');
      tracker.setCurrentPhase('planning');
      expect(tracker.currentPhaseId).toBe('planning');
      expect(tracker.completedPhaseIds).toEqual([]);
    });
  });

  // ── registerPhase ──────────────────────────────────────────────────

  describe('registerPhase', () => {
    it('stores a phase definition', () => {
      tracker.registerPhase({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      expect(tracker.phases).toHaveLength(1);
      expect(tracker.phases[0]).toEqual({ id: 'scouting', label: 'Scouting', icon: '🔍' });
    });

    it('stores multiple phase definitions', () => {
      tracker.registerPhase({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      tracker.registerPhase({ id: 'planning', label: 'Planning', icon: '📋' });
      tracker.registerPhase({ id: 'implementing', label: 'Implementing', icon: '💻' });
      expect(tracker.phases).toHaveLength(3);
    });

    it('phases getter returns a defensive copy', () => {
      tracker.registerPhase({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      const phases = tracker.phases;
      phases.push({ id: 'fake', label: 'Fake', icon: '?' });
      expect(tracker.phases).toHaveLength(1);
    });

    it('allows registering the same phase id multiple times (no dedup)', () => {
      tracker.registerPhase({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      tracker.registerPhase({ id: 'scouting', label: 'Scouting v2', icon: '🔎' });
      expect(tracker.phases).toHaveLength(2);
    });

    it('triggers auto-persist', async () => {
      tracker.registerPhase({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 30));
      const raw = await fs.readFile(path.join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('');
    });
  });

  // ── registerTask ──────────────────────────────────────────────────

  describe('registerTask', () => {
    it('adds a task to the task tracker', () => {
      tracker.registerTask({ taskId: 't1', phaseId: 'scouting', title: 'Scout the codebase', dependencies: [] });
      const tasks = tracker.taskTracker.getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('t1');
      expect(tasks[0].phaseId).toBe('scouting');
      expect(tasks[0].title).toBe('Scout the codebase');
      expect(tasks[0].dependencies).toEqual([]);
    });

    it('adds a task with dependencies', () => {
      tracker.registerTask({ taskId: 't1', phaseId: 'scouting', title: 'Task 1', dependencies: [] });
      tracker.registerTask({ taskId: 't2', phaseId: 'planning', title: 'Task 2', dependencies: ['t1'] });
      const tasks = tracker.taskTracker.getAllTasks();
      expect(tasks).toHaveLength(2);
      const t2 = tasks.find((t) => t.id === 't2')!;
      expect(t2.dependencies).toEqual(['t1']);
    });

    it('triggers auto-persist', async () => {
      tracker.registerTask({ taskId: 't1', phaseId: 'scouting', title: 'Scout', dependencies: [] });
      await new Promise((r) => setTimeout(r, 30));
      const raw = await fs.readFile(path.join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].id).toBe('t1');
    });
  });

  // ── setWorkflowData / scoutingReports ────────────────────────────────

  describe('setWorkflowData – scoutingReports', () => {
    it('stores the reports', () => {
      const reports = [{ summary: 'found issues' }, { summary: 'all clear' }];
      tracker.setWorkflowData({ scoutingReports: reports });
      expect((tracker.workflowData as Record<string, unknown>).scoutingReports).toEqual(reports);
    });

    it('overwrites previous reports', () => {
      tracker.setWorkflowData({ scoutingReports: [{ a: 1 }] });
      tracker.setWorkflowData({ scoutingReports: [{ b: 2 }] });
      expect((tracker.workflowData as Record<string, unknown>).scoutingReports).toEqual([{ b: 2 }]);
    });
  });

  // ── setWorkflowData / plan ─────────────────────────────────────────

  describe('setWorkflowData – plan', () => {
    it('stores the plan', () => {
      const plan = { tasks: ['t1', 't2'], estimate: '2h' };
      tracker.setWorkflowData({ plan });
      expect((tracker.workflowData as Record<string, unknown>).plan).toEqual(plan);
    });

    it('overwrites previous plan', () => {
      tracker.setWorkflowData({ plan: { version: 1 } });
      tracker.setWorkflowData({ plan: { version: 2 } });
      expect((tracker.workflowData as Record<string, unknown>).plan).toEqual({ version: 2 });
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

  // ── setWorkflowData / planReviewFeedback ──────────────────────────

  describe('setWorkflowData – planReviewFeedback', () => {
    it('getters return undefined initially', () => {
      const data = tracker.workflowData as Record<string, unknown>;
      expect(data.planReviewFeedback).toBeUndefined();
      expect(data.planReviewSuggestions).toBeUndefined();
    });

    it('setWorkflowData stores both feedback and suggestions', () => {
      tracker.setWorkflowData({
        planReviewFeedback: 'Missing error handling',
        planReviewSuggestions: ['Add try/catch'],
      });
      const data = tracker.workflowData as Record<string, unknown>;
      expect(data.planReviewFeedback).toBe('Missing error handling');
      expect(data.planReviewSuggestions).toEqual(['Add try/catch']);
    });

    it('planReviewSuggestions getter returns a defensive copy', () => {
      tracker.setWorkflowData({ planReviewFeedback: 'Needs improvement', planReviewSuggestions: ['s1', 's2'] });
      const data = tracker.workflowData as Record<string, unknown>;
      const suggestions = data.planReviewSuggestions as string[] | undefined;
      if (suggestions) {
        suggestions.push('s3');
      }
      expect((tracker.workflowData as Record<string, unknown>).planReviewSuggestions).toEqual(['s1', 's2']);
    });

    it('clearPlanReviewFeedback resets both to undefined', () => {
      tracker.setWorkflowData({ planReviewFeedback: 'Feedback', planReviewSuggestions: ['Suggestion'] });
      tracker.setWorkflowData({ planReviewFeedback: undefined, planReviewSuggestions: undefined });
      const data = tracker.workflowData as Record<string, unknown>;
      expect(data.planReviewFeedback).toBeUndefined();
      expect(data.planReviewSuggestions).toBeUndefined();
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────

  describe('toJSON', () => {
    it('returns a complete WorkflowState object', () => {
      tracker.setTaskPrompt('my prompt');
      tracker.setWorkflowData({ scoutingReports: [{ note: 'hello' }], plan: { steps: [1, 2, 3] } });
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();

      const json = tracker.toJSON();

      expect(json.taskPrompt).toBe('my prompt');
      expect(json.currentPhaseId).toBe('');
      expect(json.completedPhaseIds).toEqual([]);
      expect(json.workflowData.scoutingReports).toEqual([{ note: 'hello' }]);
      expect(json.workflowData.plan).toEqual({ steps: [1, 2, 3] });
      expect(json.stats).toEqual({ totalTokens: 150, totalCost: 0, agentCount: 1 });
      expect(json.tasks).toEqual([]);
    });

    it('includes planReviewFeedback fields when set', () => {
      tracker.setWorkflowData({
        planReviewFeedback: 'Missing error handling',
        planReviewSuggestions: ['Add try/catch'],
      });

      const json = tracker.toJSON();

      expect(json.workflowData.planReviewFeedback).toBe('Missing error handling');
      expect(json.workflowData.planReviewSuggestions).toEqual(['Add try/catch']);
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
      tracker.setWorkflowData({
        scoutingReports: [{ summary: 'report 1' }, { summary: 'report 2' }],
        plan: { phases: ['a', 'b', 'c'] },
      });
      tracker.addTokensToStats({ input: 500, output: 250 });
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();
      tracker.incrementAgentCount();

      // Transition two phases
      tracker.setPhase('scouting');
      tracker.setPhase('planning');

      // Add a task
      tracker.taskTracker.addTask(makeTask({ id: 'task-a' }));
      tracker.taskTracker.addTask({ ...makeTask({ id: 'task-b', dependencies: ['task-a'] }), status: undefined });

      await tracker.save();

      // Load into a new tracker
      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.taskPrompt).toBe('Build something great');
      expect(restored.currentPhaseId).toBe('planning');
      expect(restored.completedPhaseIds).toEqual(['scouting']);
      const restoredData = restored.workflowData as Record<string, unknown>;
      expect(restoredData.scoutingReports).toEqual([{ summary: 'report 1' }, { summary: 'report 2' }]);
      expect(restoredData.plan).toEqual({ phases: ['a', 'b', 'c'] });
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
      tracker.setWorkflowData({ planReviewFeedback: 'Build error handling', planReviewSuggestions: ['Add try/catch'] });

      await tracker.save();
      const restored = await WorkflowStatusTracker.load(dir);

      const restoredData = restored.workflowData as Record<string, unknown>;
      expect(restoredData.planReviewFeedback).toBe('Build error handling');
      expect(restoredData.planReviewSuggestions).toEqual(['Add try/catch']);
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
      tracker.taskTracker.claimTasks(1, 'agent-1');
      tracker.taskTracker.completeTask('a');

      await tracker.save();
      const restored = await WorkflowStatusTracker.load(dir);

      expect(restored.taskTracker.getTask('a')!.status).toBe('complete');
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

      tracker.taskTracker.claimTasks(1, 'agent-x');
      tracker.taskTracker.completeTask('t1');

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('complete');
      expect(restored.taskPrompt).toBe('auto-persist-test');
    });

    it('failTask triggers auto-persist to disk', async () => {
      tracker.setTaskPrompt('fail-persist-test');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      tracker.taskTracker.claimTasks(1, 'agent-x');
      tracker.taskTracker.failTask('t1', { error: 'boom' });

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      // On resume, failed tasks are reset to 'ready' for retry
      expect(restored.taskTracker.getTask('t1')!.status).toBe('ready');
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
      restored.taskTracker.claimTasks(1, 'agent-x');
      restored.taskTracker.completeTask('t1');

      await restored.save();

      // Reload from disk — should reflect the completed task
      const reloaded = await WorkflowStatusTracker.load(dir);
      expect(reloaded.taskTracker.getTask('t1')!.status).toBe('complete');
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

      tracker.taskTracker.claimTasks(1, 'agent-x');

      // completeTask should not throw — save() is fire-and-forget with .catch()
      tracker.taskTracker.completeTask('t1');

      await tracker.save().catch(() => {});

      // In-memory state is still correct despite the save failure
      expect(tracker.taskTracker.getTask('t1')!.status).toBe('complete');
      expect(saveWasCalled).toBe(true);

      // Restore original save method for cleanup
      tracker.save = originalSave;
    });
  });

  // ── dispose() ──────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('can be called multiple times without error', () => {
      expect(() => {
        tracker.dispose();
        tracker.dispose();
        tracker.dispose();
      }).not.toThrow();
    });
  });

  describe('dispose() with isolated dirs', () => {
    const temp = useTempDir();
    let isolatedDir: string;
    let isolatedTracker: WorkflowStatusTracker;

    beforeEach(() => {
      isolatedDir = temp.getDir();
      isolatedTracker = new WorkflowStatusTracker(isolatedDir);
    });

    it('removes event listeners so task changes no longer trigger auto-persist', async () => {
      isolatedTracker.dispose();

      // Adding a task should NOT trigger auto-persist after dispose
      isolatedTracker.taskTracker.addTask({
        id: 't1',
        title: 'Test',
        prompt: 'p',
        profile: 'prof',
        files: [],
        dependencies: [],
      });

      await expect(fs.readFile(path.join(isolatedDir, '.engin-state.json'), 'utf-8')).rejects.toThrow();
    });

    it('removes listeners so settled tasks no longer trigger auto-persist', async () => {
      isolatedTracker.taskTracker.addTask(makeTask({ id: 't1' }));
      await isolatedTracker.save();

      isolatedTracker.dispose();

      // Completing a task after dispose should NOT write to disk
      isolatedTracker.taskTracker.claimTasks(1, 'agent-1');
      isolatedTracker.taskTracker.completeTask('t1');

      // Load from disk — the task should still be 'ready' (pre-dispose state)
      const restored = await WorkflowStatusTracker.load(isolatedDir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('ready');
    });
  });

  // ── AbortSignal ────────────────────────────────────────────────────

  describe('AbortSignal', () => {
    it('constructor accepts an optional AbortSignal as second parameter', () => {
      const ac = new AbortController();
      const withSignal = new WorkflowStatusTracker(dir, ac.signal);
      expect(withSignal).toBeDefined();
      expect(withSignal.taskTracker).toBeDefined();
      withSignal.dispose();
    });

    it('calling abort() on the signal triggers dispose() automatically', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      // Spy on dispose by checking event listeners are removed after abort
      signalTracker.taskTracker.addTask(makeTask({ id: 't1' }));
      ac.abort();

      // After abort, listeners should be removed — task operations should not throw
      expect(() => {
        signalTracker.taskTracker.addTask(makeTask({ id: 't2' }));
      }).not.toThrow();
    });

    it('auto-persist is disabled after signal abort', async () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      signalTracker.setTaskPrompt('abort-test');
      signalTracker.taskTracker.addTask(makeTask({ id: 't1' }));

      ac.abort();

      // Complete a task after abort — should NOT persist
      signalTracker.taskTracker.claimTasks(1, 'agent-1');
      signalTracker.taskTracker.completeTask('t1');

      // The original tracker never saved, so load should fail
      await expect(WorkflowStatusTracker.load(dir)).rejects.toThrow('Workflow state file not found');
    });

    it('signal abort with once:true ensures listener is called only once', () => {
      const ac = new AbortController();
      let disposeCallCount = 0;

      // Create tracker with signal
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      // Override dispose to count calls
      const originalDispose = signalTracker.dispose.bind(signalTracker);
      signalTracker.dispose = () => {
        disposeCallCount++;
        originalDispose();
      };

      ac.abort(); // First abort triggers dispose
      ac.abort(); // Second abort should do nothing (once:true)

      expect(disposeCallCount).toBe(1);

      // Restore
      signalTracker.dispose = originalDispose;
    });

    it('dispose() sets _signal to null (covered by no double-free)', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);
      signalTracker.dispose();
      // Second dispose should not throw
      expect(() => signalTracker.dispose()).not.toThrow();
    });

    it('without signal, behavior is unchanged', () => {
      const noSignal = new WorkflowStatusTracker(dir);
      expect(noSignal).toBeDefined();
      expect(() => noSignal.dispose()).not.toThrow();
    });

    it('static load() creates a tracker without a signal (known limitation)', async () => {
      // First save with a normal tracker
      tracker.setTaskPrompt('load-test');
      await tracker.save();

      // Load without signal — should work fine
      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('load-test');
      // No signal attached, so dispose still works
      expect(() => restored.dispose()).not.toThrow();
    });

    it('multiple trackers can share the same signal', () => {
      const ac = new AbortController();
      const t1 = new WorkflowStatusTracker(dir, ac.signal);
      const t2 = new WorkflowStatusTracker(dir, ac.signal);

      ac.abort();

      // Both should be disposed (listeners removed)
      expect(() => t1.dispose()).not.toThrow();
      expect(() => t2.dispose()).not.toThrow();
    });

    it('abort signal after manual dispose does not double-free', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      signalTracker.dispose(); // Manual dispose first
      ac.abort(); // Then abort — should not throw

      expect(() => signalTracker.dispose()).not.toThrow();
    });

    it('abort signal cancels active tasks before disposal', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      // Add a task and set it to active
      signalTracker.taskTracker.addTask(makeTask({ id: 'active-task' }));
      signalTracker.taskTracker.claimTasks(1, 'agent-1');

      expect(signalTracker.taskTracker.getTask('active-task')!.status).toBe('active');

      // Abort should cancel it
      ac.abort();

      expect(signalTracker.taskTracker.getTask('active-task')!.status).toBe('cancelled');
    });

    it('abort signal only cancels active tasks, not ready/blocked ones', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      signalTracker.taskTracker.addTask(makeTask({ id: 'active-task' }));
      signalTracker.taskTracker.addTask(makeTask({ id: 'ready-task' }));
      signalTracker.taskTracker.addTask({
        ...makeTask({ id: 'blocked-task', dependencies: ['active-task'] }),
        status: undefined,
      });

      // Claim and start the first task
      signalTracker.taskTracker.claimTasks(1, 'agent-1');

      expect(signalTracker.taskTracker.getTask('active-task')!.status).toBe('active');
      expect(signalTracker.taskTracker.getTask('ready-task')!.status).toBe('ready');
      // blocked-task should be blocked because active-task isn't settled yet
      expect(signalTracker.taskTracker.getTask('blocked-task')!.status).toBe('blocked');

      ac.abort();

      // Only the active task should be cancelled
      expect(signalTracker.taskTracker.getTask('active-task')!.status).toBe('cancelled');
      expect(signalTracker.taskTracker.getTask('ready-task')!.status).toBe('ready');
      expect(signalTracker.taskTracker.getTask('blocked-task')!.status).toBe('blocked');
    });

    it('abort with no active tasks still disposes cleanly', () => {
      const ac = new AbortController();
      const signalTracker = new WorkflowStatusTracker(dir, ac.signal);

      // No tasks at all
      expect(() => ac.abort()).not.toThrow();
      expect(signalTracker.taskTracker.getAllTasks()).toEqual([]);
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('setPhase works from a non-default starting point', () => {
      tracker.setCurrentPhase('scouting');
      tracker.setPhase('planning');
      expect(tracker.currentPhaseId).toBe('planning');
      expect(tracker.completedPhaseIds).toEqual(['scouting']);
    });

    it('completedPhaseIds only tracks setPhase transitions, not setCurrentPhase', () => {
      tracker.setCurrentPhase('scouting');
      // completedPhaseIds should still be empty since setCurrentPhase doesn't push
      expect(tracker.completedPhaseIds).toEqual([]);

      tracker.setPhase('planning');
      expect(tracker.currentPhaseId).toBe('planning');
      expect(tracker.completedPhaseIds).toEqual(['scouting']);
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
      tracker.setWorkflowData({ plan: complexPlan });
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const restoredData = restored.workflowData as Record<string, unknown>;
      expect(restoredData.plan).toEqual(complexPlan);
    });
  });
});
