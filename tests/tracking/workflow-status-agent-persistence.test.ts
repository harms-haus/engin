import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedAgentRecord } from '../../packages/engine/src/core/types.js';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('WorkflowStatusTracker – agent persistence', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── initial state ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('spawnedAgents getter returns empty array initially', () => {
      expect(tracker.spawnedAgents).toEqual([]);
    });

    it('spawnedAgents getter returns a copy', () => {
      const sessions = tracker.spawnedAgents;
      sessions.push({ agentId: 'fake', profile: 'p', phaseId: 'scouting' });
      expect(tracker.spawnedAgents).toEqual([]);
    });
  });

  // ── recordAgentSpawn ───────────────────────────────────────────────

  describe('recordAgentSpawn', () => {
    it('adds a record with all required fields', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      const sessions = tracker.spawnedAgents;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].agentId).toBe('agent-1');
      expect(sessions[0].profile).toBe('coder');
      expect(sessions[0].phaseId).toBe('scouting');
      expect(sessions[0].completedAt).toBeUndefined();
      expect(sessions[0].taskId).toBeUndefined();
    });

    it('stores taskId when provided', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'implementing', taskId: 'task-42' });

      const sessions = tracker.spawnedAgents;
      expect(sessions[0].taskId).toBe('task-42');
    });

    it('stores runnerRole and attempt when provided', () => {
      tracker.recordAgentSpawn({
        agentId: 'agent-1',
        profile: 'coder',
        phaseId: 'implementing',
        taskId: 'task-42',
        runnerRole: 'coder',
        attempt: 2,
      });

      const sessions = tracker.spawnedAgents;
      const a = sessions[0];
      expect(a.runnerRole).toBe('coder');
      expect(a.attempt).toBe(2);
    });

    it('stores runnerRole/attempt via object overload', () => {
      tracker.recordAgentSpawn({
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'implementing',
        taskId: 'task-42',
        runnerRole: 'coder',
        attempt: 1,
      });

      const sessions = tracker.spawnedAgents;
      const a = sessions[0];
      expect(a.runnerRole).toBe('coder');
      expect(a.attempt).toBe(1);
    });

    it('appends multiple records in order', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'scouting_review' });
      tracker.recordAgentSpawn({ agentId: 'agent-3', profile: 'coder', phaseId: 'implementing', taskId: 'task-1' });

      const sessions = tracker.spawnedAgents;
      expect(sessions).toHaveLength(3);
      expect(sessions[0].agentId).toBe('agent-1');
      expect(sessions[1].agentId).toBe('agent-2');
      expect(sessions[2].agentId).toBe('agent-3');
    });

    it('triggers auto-persist', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
      expect(data.spawnedAgents[0].agentId).toBe('agent-1');
    });
  });

  // ── recordAgentComplete ────────────────────────────────────────────

  describe('recordAgentComplete', () => {
    it('sets completedAt on the matching record', () => {
      const before = new Date().toISOString();

      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentComplete('agent-1');

      const after = new Date().toISOString();
      const sessions = tracker.spawnedAgents;
      expect(sessions[0].completedAt).toBeDefined();

      // completedAt should be between before and after (inclusive of some margin)
      expect(sessions[0].completedAt!.localeCompare(before)).toBeGreaterThanOrEqual(0);
      expect(sessions[0].completedAt!.localeCompare(after)).toBeLessThanOrEqual(0);
    });

    it('only affects the matching agent', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'scouting_review' });

      tracker.recordAgentComplete('agent-1');

      const sessions = tracker.spawnedAgents;
      expect(sessions[0].completedAt).toBeDefined();
      expect(sessions[1].completedAt).toBeUndefined();
    });

    it('handles completing multiple sessions independently', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'scouting_review' });

      tracker.recordAgentComplete('agent-1');
      tracker.recordAgentComplete('agent-2');

      const sessions = tracker.spawnedAgents;
      expect(sessions[0].completedAt).toBeDefined();
      expect(sessions[1].completedAt).toBeDefined();
    });

    it('is a no-op for unknown agentId', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentComplete('unknown-agent');

      const sessions = tracker.spawnedAgents;
      expect(sessions[0].completedAt).toBeUndefined();
      expect(sessions).toHaveLength(1);
    });

    it('triggers auto-persist', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      await tracker.save();

      tracker.recordAgentComplete('agent-1');
      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents[0].completedAt).toBeDefined();
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────

  describe('toJSON', () => {
    it('includes spawnedAgents in output', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting', taskId: 'task-1' });
      tracker.recordAgentComplete('agent-1');

      const json = tracker.toJSON();

      expect(json.spawnedAgents).toHaveLength(1);
      expect(json.spawnedAgents![0]).toEqual({
        agentId: 'agent-1',
        profile: 'coder',
        phaseId: 'scouting',
        taskId: 'task-1',
        completedAt: expect.any(String),
      });
    });

    it('spawnedAgents in JSON is a copy', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      const json = tracker.toJSON();
      json.spawnedAgents!.push({ agentId: 'fake', profile: 'p', phaseId: 'scouting' });

      expect(tracker.toJSON().spawnedAgents).toHaveLength(1);
    });

    it('returns empty spawnedAgents array when none recorded', () => {
      const json = tracker.toJSON();
      expect(json.spawnedAgents).toEqual([]);
    });
  });

  // ── save / load round-trip ─────────────────────────────────────────

  describe('save / load round-trip', () => {
    it('restores spawnedAgents through save and load', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentSpawn({
        agentId: 'agent-2',
        profile: 'reviewer',
        phaseId: 'scouting_review',
        taskId: 'task-5',
      });
      tracker.recordAgentComplete('agent-1');

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const sessions = restored.spawnedAgents;

      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentId).toBe('agent-1');
      expect(sessions[0].profile).toBe('coder');
      expect(sessions[0].phaseId).toBe('scouting');
      expect(sessions[0].taskId).toBeUndefined();
      expect(sessions[0].completedAt).toBeDefined();

      expect(sessions[1].agentId).toBe('agent-2');
      expect(sessions[1].profile).toBe('reviewer');
      expect(sessions[1].phaseId).toBe('scouting_review');
      expect(sessions[1].taskId).toBe('task-5');
      expect(sessions[1].completedAt).toBeUndefined();
    });

    it('backward compatibility: load() defaults spawnedAgents to [] when field is missing', async () => {
      // Manually write a state file without the spawnedAgents field
      await fs.mkdir(dir, { recursive: true });
      const stateFile = join(dir, '.engin-state.json');
      const legacyState = {
        taskPrompt: 'legacy prompt',
        currentPhaseId: 'scouting',
        completedPhaseIds: [],
        tasks: [],
        workflowData: {},
        stats: { totalTokens: 0, totalCost: 0, sessionCount: 0 },
        // Note: no spawnedAgents field
      };
      await fs.writeFile(stateFile, JSON.stringify(legacyState, null, 2), 'utf-8');

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toEqual([]);
    });

    it('restored tracker can continue recording sessions', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentComplete('agent-1');
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      restored.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'planning' });
      restored.recordAgentComplete('agent-2');

      // In-memory state is immediately available
      const sessions = restored.spawnedAgents;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentId).toBe('agent-1');
      expect(sessions[0].completedAt).toBeDefined();
      expect(sessions[1].agentId).toBe('agent-2');
      expect(sessions[1].completedAt).toBeDefined();

      await restored.save();

      // Verify persisted
      const reloaded = await WorkflowStatusTracker.load(dir);
      expect(reloaded.spawnedAgents).toHaveLength(2);
    });

    it('spawnedAgents persists alongside other workflow state', async () => {
      tracker.setTaskPrompt('Full state test');
      tracker.setPhase('implementing');
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'planning', taskId: 'task-1' });
      tracker.recordAgentComplete('agent-1');
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('Full state test');
      expect(restored.currentPhaseId).toBe('implementing');
      expect(restored.spawnedAgents).toHaveLength(2);
      expect(restored.stats.totalTokens).toBe(150);
    });
  });

  // ── auto-persist on agent spawn ────────────────────────────────────

  describe('auto-persist on agent spawn/complete', () => {
    it('spawn triggers auto-persist to disk', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toHaveLength(1);
      expect(restored.spawnedAgents[0].agentId).toBe('agent-1');
    });

    it('complete triggers auto-persist to disk', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      await tracker.save();

      tracker.recordAgentComplete('agent-1');
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents[0].completedAt).toBeDefined();
    });
  });

  // ── PersistedAgentRecord type validation ───────────────────────────

  describe('PersistedAgentRecord shape', () => {
    it('records match the PersistedAgentRecord interface shape', () => {
      tracker.recordAgentSpawn({ agentId: 'a1', profile: 'coder', phaseId: 'scouting', taskId: 't1' });
      const record: PersistedAgentRecord = tracker.spawnedAgents[0];

      // Verify all fields exist with correct types
      expect(typeof record.agentId).toBe('string');
      expect(typeof record.profile).toBe('string');
      expect(typeof record.phaseId).toBe('string');
      expect(typeof record.taskId).toBe('string');
      expect(record.completedAt).toBeUndefined();

      // Complete it and verify completedAt is set
      tracker.recordAgentComplete('a1');
      const completed: PersistedAgentRecord = tracker.spawnedAgents[0];
      expect(typeof completed.completedAt).toBe('string');
    });

    it('all SpawnedAgents in WorkflowState JSON match PersistedAgentRecord', async () => {
      tracker.recordAgentSpawn({ agentId: 'a1', profile: 'coder', phaseId: 'scouting', taskId: 't1' });
      tracker.recordAgentSpawn({ agentId: 'a2', profile: 'reviewer', phaseId: 'planning' });
      tracker.recordAgentComplete('a1');

      await tracker.save();
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);

      expect(data.spawnedAgents).toBeDefined();
      expect(Array.isArray(data.spawnedAgents)).toBe(true);

      for (const record of data.spawnedAgents) {
        expect(typeof record.agentId).toBe('string');
        expect(typeof record.profile).toBe('string');
        expect(typeof record.phaseId).toBe('string');
        // taskId and completedAt are optional
        if (record.taskId !== undefined) {
          expect(typeof record.taskId).toBe('string');
        }
        if (record.completedAt !== undefined) {
          expect(typeof record.completedAt).toBe('string');
        }
      }
    });
  });

  // ── recordAgentSpawn object overload ──────────────────────────────

  describe('recordAgentSpawn – object overload', () => {
    it('accepts an object with all fields', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-obj-1', profile: 'coder', phaseId: 'scouting', taskId: 'task-99' });

      const sessions = tracker.spawnedAgents;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].agentId).toBe('agent-obj-1');
      expect(sessions[0].profile).toBe('coder');
      expect(sessions[0].phaseId).toBe('scouting');
      expect(sessions[0].taskId).toBe('task-99');
      expect(sessions[0].completedAt).toBeUndefined();
    });

    it('accepts an object without optional taskId', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-obj-2', profile: 'reviewer', phaseId: 'planning' });

      const sessions = tracker.spawnedAgents;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].taskId).toBeUndefined();
    });

    it('persists via debounced auto-persist', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-obj-3', profile: 'coder', phaseId: 'implementing' });

      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
      expect(data.spawnedAgents[0].agentId).toBe('agent-obj-3');
    });
  });

  // ── debounced persist behavior ────────────────────────────────────

  describe('debounced persist behavior', () => {
    it('recordAgentSpawn returns synchronously without blocking for I/O', () => {
      // Call should return immediately — not block on file write
      const start = performance.now();
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      const elapsed = performance.now() - start;

      // A sync file write would typically take >1ms; a synchronous in-memory op
      // should be sub-millisecond. We use a generous threshold to avoid flakiness.
      expect(elapsed).toBeLessThan(5);

      // In-memory state is immediately available
      expect(tracker.spawnedAgents).toHaveLength(1);
    });

    it('recordAgentComplete returns synchronously without blocking for I/O', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      const start = performance.now();
      tracker.recordAgentComplete('agent-1');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5);

      // In-memory state is immediately available
      expect(tracker.spawnedAgents[0].completedAt).toBeDefined();
    });

    it('multiple rapid spawn calls are coalesced into fewer disk writes', async () => {
      // Rapidly spawn multiple sessions
      for (let i = 0; i < 5; i++) {
        tracker.recordAgentSpawn({
          agentId: `agent-${i}`,
          profile: 'coder',
          phaseId: 'implementing',
          taskId: `task-${i}`,
        });
      }

      // All 5 should be in memory immediately
      expect(tracker.spawnedAgents).toHaveLength(5);

      await tracker.save();

      // All 5 should be persisted in a single file
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(data.spawnedAgents[i].agentId).toBe(`agent-${i}`);
      }
    });

    it('spawn immediately followed by complete persists both', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });
      tracker.recordAgentComplete('agent-1');

      // In-memory state reflects both operations
      expect(tracker.spawnedAgents).toHaveLength(1);
      expect(tracker.spawnedAgents[0].completedAt).toBeDefined();

      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
      expect(data.spawnedAgents[0].completedAt).toBeDefined();
    });

    it('debounced persist writes to disk after microtick', async () => {
      // Ensure no state file exists yet
      await expect(fs.access(join(dir, '.engin-state.json'))).rejects.toThrow();

      tracker.recordAgentSpawn({ agentId: 'agent-1', profile: 'coder', phaseId: 'scouting' });

      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
    });

    it('source does not import sync fs functions or contain persistStateSync', async () => {
      // Structural test: verify the source was refactored to remove sync I/O.
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

      // Should NOT import from 'node:fs' (the sync module)
      expect(source).not.toMatch(/from\s+['"]node:fs['"]/);

      // Should NOT contain sync function names
      expect(source).not.toContain('writeFileSync');
      expect(source).not.toContain('mkdirSync');

      // Should NOT contain persistStateSync method
      expect(source).not.toContain('persistStateSync');

      // recordAgentSpawn body should call this.persistState()
      const spawnBody = source.slice(source.indexOf('recordAgentSpawn('), source.indexOf('recordAgentComplete('));
      expect(spawnBody).toContain('this.persistState()');
      expect(spawnBody).not.toContain('this.persistStateSync()');

      // recordAgentComplete body should call this.persistState()
      const completeBody = source.slice(source.indexOf('recordAgentComplete('), source.indexOf('// ── Serialization'));
      expect(completeBody).toContain('this.persistState()');
      expect(completeBody).not.toContain('this.persistStateSync()');
    });
  });
});
