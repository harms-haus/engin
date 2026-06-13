import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowState } from '../../src/core/types.js';
import {
  loadWorkflowState,
  saveWorkflowState,
  serializeWorkflowState,
} from '../../src/tracking/workflow-serializer.js';
import { WorkflowStatusTracker } from '../../src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('workflow-serializer', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── serializeWorkflowState ──────────────────────────────────────────

  describe('serializeWorkflowState', () => {
    it('returns a WorkflowState with default values for a fresh tracker', () => {
      const state = serializeWorkflowState(tracker);

      expect(state.taskPrompt).toBe('');
      expect(state.currentPhase).toBe('');
      expect(state.completedPhases).toEqual([]);
      expect(state.scoutingReports).toEqual([]);
      expect(state.plan).toBeUndefined();
      expect(state.stats).toEqual({ totalTokens: 0, totalCost: 0, agentCount: 0 });
      expect(state.tasks).toEqual([]);
      expect(state.spawnedAgents).toEqual([]);
    });

    it('includes all set properties', () => {
      tracker.setTaskPrompt('Build a thing');
      tracker.setCurrentPhase('implementing');
      tracker.setScoutingReports([{ summary: 'done' }]);
      tracker.setPlan({ steps: ['a', 'b'] });
      tracker.setResearch('research notes');
      tracker.setPlanReviewFeedback('Great', ['Fix this']);
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.setWorktree({
        worktreePath: '/tmp/wt',
        branchName: 'main',
        originalCwd: '/home/user',
      });
      tracker.setSidebar({ title: 'My Workflow' });

      const state = serializeWorkflowState(tracker);

      expect(state.taskPrompt).toBe('Build a thing');
      expect(state.currentPhase).toBe('implementing');
      expect(state.completedPhases).toEqual([]);
      expect(state.scoutingReports).toEqual([{ summary: 'done' }]);
      expect(state.plan).toEqual({ steps: ['a', 'b'] });
      expect(state.research).toBe('research notes');
      expect(state.planReviewFeedback).toBe('Great');
      expect(state.planReviewSuggestions).toEqual(['Fix this']);
      expect(state.stats).toEqual({ totalTokens: 150, totalCost: 0, agentCount: 1 });
      expect(state.spawnedAgents).toHaveLength(1);
      expect(state.spawnedAgents![0].agentId).toBe('agent-1');
      expect(state.worktree).toBeDefined();
      expect(state.worktree!.branchName).toBe('main');
      expect(state.sidebar).toBeDefined();
      expect(state.sidebar!.title).toBe('My Workflow');
    });

    it('includes tasks from the task tracker', () => {
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));
      tracker.taskTracker.addTask(makeTask({ id: 't2' }));

      const state = serializeWorkflowState(tracker);
      expect(state.tasks).toHaveLength(2);
      expect(state.tasks.find((t) => t.id === 't1')).toBeDefined();
      expect(state.tasks.find((t) => t.id === 't2')).toBeDefined();
    });

    it('returns a defensive copy — mutations do not affect tracker', () => {
      tracker.setTaskPrompt('original');
      tracker.setPlan({ key: 'value' });
      tracker.recordAgentSpawn('a1', 'coder', 'scouting');

      const state = serializeWorkflowState(tracker);
      state.taskPrompt = 'mutated';
      state.plan = { key: 'mutated' };
      state.stats.totalTokens = 999;
      state.spawnedAgents!.push({ agentId: 'fake', profile: 'p', phase: 'scouting' });
      state.completedPhases.push('fake-phase');

      expect(tracker.taskPrompt).toBe('original');
      expect(tracker.plan).toEqual({ key: 'value' });
      expect(tracker.stats.totalTokens).toBe(0);
      expect(tracker.spawnedAgents).toHaveLength(1);
      expect(tracker.completedPhases).toEqual([]);
    });

    it('returns undefined sidebar and worktree when not set', () => {
      const state = serializeWorkflowState(tracker);
      expect(state.sidebar).toBeUndefined();
      expect(state.worktree).toBeUndefined();
    });

    it('returns empty spawnedAgents when none recorded', () => {
      const state = serializeWorkflowState(tracker);
      expect(state.spawnedAgents).toEqual([]);
    });
  });

  // ── saveWorkflowState ───────────────────────────────────────────────

  describe('saveWorkflowState', () => {
    it('writes state to disk as JSON', async () => {
      tracker.setTaskPrompt('save test');

      await saveWorkflowState(tracker, dir);

      const filePath = join(dir, '.engin-state.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as WorkflowState;
      expect(parsed.taskPrompt).toBe('save test');
    });

    it('uses atomic write via temp file rename', async () => {
      tracker.setTaskPrompt('atomic');

      await saveWorkflowState(tracker, dir);

      // Temp file should be cleaned up
      const tmpPath = join(dir, '.engin-state.json.tmp');
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // State file should exist and be valid
      const statePath = join(dir, '.engin-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      expect(JSON.parse(content).taskPrompt).toBe('atomic');
    });

    it('creates the directory if it does not exist', async () => {
      const nestedDir = join(dir, 'deep', 'nested');
      tracker.setTaskPrompt('nested save');

      await saveWorkflowState(tracker, nestedDir);

      const statePath = join(nestedDir, '.engin-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      expect(JSON.parse(content).taskPrompt).toBe('nested save');
    });

    it('overwrites an existing state file', async () => {
      // First save
      tracker.setTaskPrompt('first');
      await saveWorkflowState(tracker, dir);

      // Second save with different data
      tracker.setTaskPrompt('second');
      await saveWorkflowState(tracker, dir);

      const statePath = join(dir, '.engin-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      expect(JSON.parse(content).taskPrompt).toBe('second');
    });

    it('handles sequential saves correctly (last write wins)', async () => {
      for (let i = 0; i < 5; i++) {
        tracker.setTaskPrompt(`sequential-${i}`);
        await saveWorkflowState(tracker, dir);
      }

      const statePath = join(dir, '.engin-state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      const parsed = JSON.parse(content) as WorkflowState;
      expect(parsed.taskPrompt).toBe('sequential-4');
    });
  });

  // ── loadWorkflowState ───────────────────────────────────────────────

  describe('loadWorkflowState', () => {
    it('reads and parses a valid state file', async () => {
      // Write a state file manually
      const state: WorkflowState = {
        taskPrompt: 'loaded',
        currentPhase: 'scouting',
        completedPhases: [],
        tasks: [],
        scoutingReports: [],
        plan: { version: 2 },
        research: 'research notes',
        planReviewFeedback: 'Feedback',
        planReviewSuggestions: ['Suggestion 1'],
        stats: { totalTokens: 100, totalCost: 0, agentCount: 1 },
        spawnedAgents: [{ agentId: 'a1', profile: 'coder', phase: 'scouting' }],
        sidebar: { title: 'Sidebar' },
        worktree: { worktreePath: '/tmp/wt', branchName: 'main', originalCwd: '/home/user' },
      };

      const filePath = join(dir, '.engin-state.json');
      await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');

      const loaded = await loadWorkflowState(dir);

      expect(loaded.taskPrompt).toBe('loaded');
      expect(loaded.currentPhase).toBe('scouting');
      expect(loaded.plan).toEqual({ version: 2 });
      expect(loaded.research).toBe('research notes');
      expect(loaded.planReviewFeedback).toBe('Feedback');
      expect(loaded.planReviewSuggestions).toEqual(['Suggestion 1']);
      expect(loaded.stats).toEqual({ totalTokens: 100, totalCost: 0, agentCount: 1 });
      expect(loaded.spawnedAgents).toHaveLength(1);
      expect(loaded.spawnedAgents![0].agentId).toBe('a1');
      expect(loaded.sidebar).toBeDefined();
      expect(loaded.sidebar!.title).toBe('Sidebar');
      expect(loaded.worktree).toBeDefined();
      expect(loaded.worktree!.branchName).toBe('main');
    });

    it('throws WorkflowState file not found for missing file', async () => {
      await expect(loadWorkflowState(join(dir, 'nonexistent'))).rejects.toThrow('Workflow state file not found');
    });

    it('throws for invalid JSON', async () => {
      const filePath = join(dir, '.engin-state.json');
      await fs.writeFile(filePath, 'not valid json', 'utf-8');

      await expect(loadWorkflowState(dir)).rejects.toThrow();
    });

    it('loads a minimal state file with only required fields', async () => {
      const minimal: WorkflowState = {
        taskPrompt: '',
        currentPhase: '',
        completedPhases: [],
        tasks: [],
        scoutingReports: [],
        plan: undefined,
        stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
      };

      const filePath = join(dir, '.engin-state.json');
      await fs.writeFile(filePath, JSON.stringify(minimal, null, 2), 'utf-8');

      const loaded = await loadWorkflowState(dir);
      expect(loaded.taskPrompt).toBe('');
      expect(loaded.spawnedAgents).toBeUndefined();
      expect(loaded.sidebar).toBeUndefined();
      expect(loaded.worktree).toBeUndefined();
    });
  });

  // ── round-trip via serializer functions ─────────────────────────────

  describe('round-trip via serializer functions', () => {
    it('serialize → save → load → produces equivalent state', async () => {
      tracker.setTaskPrompt('Round trip');
      tracker.setCurrentPhase('implementing');
      tracker.setPhase('review');
      tracker.setScoutingReports([{ summary: 'Done' }]);
      tracker.setPlan({ tasks: ['t1'] });
      tracker.setResearch('Some research');
      tracker.setPlanReviewFeedback('Looks good', ['Minor fix']);
      tracker.addTokensToStats({ input: 200, output: 100 });
      tracker.incrementAgentCount();
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentComplete('agent-1');
      tracker.setWorktree({
        worktreePath: '/tmp/wt',
        branchName: 'feature/branch',
        originalCwd: '/home/user',
      });
      tracker.setSidebar({ title: 'My Workflow', indicator: 'running' });
      tracker.taskTracker.addTask(makeTask({ id: 'task-roundtrip' }));

      // Save using standalone function
      await saveWorkflowState(tracker, dir);

      // Load using standalone function
      const loaded = await loadWorkflowState(dir);

      expect(loaded.taskPrompt).toBe('Round trip');
      expect(loaded.currentPhase).toBe('review');
      expect(loaded.completedPhases).toEqual(['implementing']);
      expect(loaded.scoutingReports).toEqual([{ summary: 'Done' }]);
      expect(loaded.plan).toEqual({ tasks: ['t1'] });
      expect(loaded.research).toBe('Some research');
      expect(loaded.planReviewFeedback).toBe('Looks good');
      expect(loaded.planReviewSuggestions).toEqual(['Minor fix']);
      expect(loaded.stats).toEqual({ totalTokens: 300, totalCost: 0, agentCount: 1 });
      expect(loaded.spawnedAgents).toHaveLength(1);
      expect(loaded.spawnedAgents![0].agentId).toBe('agent-1');
      expect(loaded.spawnedAgents![0].completedAt).toBeDefined();
      expect(loaded.worktree).toBeDefined();
      expect(loaded.worktree!.branchName).toBe('feature/branch');
      expect(loaded.sidebar).toBeDefined();
      expect(loaded.sidebar!.title).toBe('My Workflow');
      expect(loaded.sidebar!.indicator).toBe('running');
      expect(loaded.tasks).toHaveLength(1);
      expect(loaded.tasks[0].id).toBe('task-roundtrip');
    });

    it('can be used independently of WorkflowStatusTracker.load()', async () => {
      // Write state with the standalone save function
      tracker.setTaskPrompt('independent');
      await saveWorkflowState(tracker, dir);

      // Read with the standalone load function
      const loaded = await loadWorkflowState(dir);
      expect(loaded.taskPrompt).toBe('independent');

      // Manually apply fields — but we just test that the loaded data is correct
      expect(loaded.taskPrompt).toBe('independent');
    });
  });
});
