import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedAgentRecord } from '../../src/core/types.js';
import { WorkflowStatusTracker } from '../../src/tracking/workflow-status.js';
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
      const agents = tracker.spawnedAgents;
      agents.push({ agentId: 'fake', profile: 'p', phase: 'scouting' });
      expect(tracker.spawnedAgents).toEqual([]);
    });
  });

  // ── recordAgentSpawn ───────────────────────────────────────────────

  describe('recordAgentSpawn', () => {
    it('adds a record with all required fields', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      const agents = tracker.spawnedAgents;
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('agent-1');
      expect(agents[0].profile).toBe('coder');
      expect(agents[0].phase).toBe('scouting');
      expect(agents[0].completedAt).toBeUndefined();
      expect(agents[0].taskId).toBeUndefined();
    });

    it('stores taskId when provided', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'implementing', 'task-42');

      const agents = tracker.spawnedAgents;
      expect(agents[0].taskId).toBe('task-42');
    });

    it('appends multiple records in order', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentSpawn('agent-2', 'reviewer', 'scouting_review');
      tracker.recordAgentSpawn('agent-3', 'coder', 'implementing', 'task-1');

      const agents = tracker.spawnedAgents;
      expect(agents).toHaveLength(3);
      expect(agents[0].agentId).toBe('agent-1');
      expect(agents[1].agentId).toBe('agent-2');
      expect(agents[2].agentId).toBe('agent-3');
    });

    it('triggers auto-persist', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      // Allow the fire-and-forget save() promise to settle
      await new Promise((r) => setTimeout(r, 50));

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

      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentComplete('agent-1');

      const after = new Date().toISOString();
      const agents = tracker.spawnedAgents;
      expect(agents[0].completedAt).toBeDefined();

      // completedAt should be between before and after (inclusive of some margin)
      expect(agents[0].completedAt!.localeCompare(before)).toBeGreaterThanOrEqual(0);
      expect(agents[0].completedAt!.localeCompare(after)).toBeLessThanOrEqual(0);
    });

    it('only affects the matching agent', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentSpawn('agent-2', 'reviewer', 'scouting_review');

      tracker.recordAgentComplete('agent-1');

      const agents = tracker.spawnedAgents;
      expect(agents[0].completedAt).toBeDefined();
      expect(agents[1].completedAt).toBeUndefined();
    });

    it('handles completing multiple agents independently', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentSpawn('agent-2', 'reviewer', 'scouting_review');

      tracker.recordAgentComplete('agent-1');
      tracker.recordAgentComplete('agent-2');

      const agents = tracker.spawnedAgents;
      expect(agents[0].completedAt).toBeDefined();
      expect(agents[1].completedAt).toBeDefined();
    });

    it('is a no-op for unknown agentId', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentComplete('unknown-agent');

      const agents = tracker.spawnedAgents;
      expect(agents[0].completedAt).toBeUndefined();
      expect(agents).toHaveLength(1);
    });

    it('triggers auto-persist', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      // Wait for spawn persist to settle
      await new Promise((r) => setTimeout(r, 50));

      tracker.recordAgentComplete('agent-1');
      await new Promise((r) => setTimeout(r, 50));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents[0].completedAt).toBeDefined();
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────

  describe('toJSON', () => {
    it('includes spawnedAgents in output', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting', 'task-1');
      tracker.recordAgentComplete('agent-1');

      const json = tracker.toJSON();

      expect(json.spawnedAgents).toHaveLength(1);
      expect(json.spawnedAgents[0]).toEqual({
        agentId: 'agent-1',
        profile: 'coder',
        phase: 'scouting',
        taskId: 'task-1',
        completedAt: expect.any(String),
      });
    });

    it('spawnedAgents in JSON is a copy', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      const json = tracker.toJSON();
      json.spawnedAgents.push({ agentId: 'fake', profile: 'p', phase: 'scouting' });

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
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentSpawn('agent-2', 'reviewer', 'scouting_review', 'task-5');
      tracker.recordAgentComplete('agent-1');

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      const agents = restored.spawnedAgents;

      expect(agents).toHaveLength(2);
      expect(agents[0].agentId).toBe('agent-1');
      expect(agents[0].profile).toBe('coder');
      expect(agents[0].phase).toBe('scouting');
      expect(agents[0].taskId).toBeUndefined();
      expect(agents[0].completedAt).toBeDefined();

      expect(agents[1].agentId).toBe('agent-2');
      expect(agents[1].profile).toBe('reviewer');
      expect(agents[1].phase).toBe('scouting_review');
      expect(agents[1].taskId).toBe('task-5');
      expect(agents[1].completedAt).toBeUndefined();
    });

    it('backward compatibility: load() defaults spawnedAgents to [] when field is missing', async () => {
      // Manually write a state file without the spawnedAgents field
      await fs.mkdir(dir, { recursive: true });
      const stateFile = join(dir, '.engin-state.json');
      const legacyState = {
        taskPrompt: 'legacy prompt',
        currentPhase: 'scouting',
        completedPhases: [],
        tasks: [],
        scoutingReports: [],
        plan: undefined,
        research: undefined,
        planReviewFeedback: undefined,
        planReviewSuggestions: undefined,
        stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
        // Note: no spawnedAgents field
      };
      await fs.writeFile(stateFile, JSON.stringify(legacyState, null, 2), 'utf-8');

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toEqual([]);
    });

    it('restored tracker can continue recording agents', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentComplete('agent-1');
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      restored.recordAgentSpawn('agent-2', 'reviewer', 'planning');
      restored.recordAgentComplete('agent-2');

      // In-memory state is immediately available
      const agents = restored.spawnedAgents;
      expect(agents).toHaveLength(2);
      expect(agents[0].agentId).toBe('agent-1');
      expect(agents[0].completedAt).toBeDefined();
      expect(agents[1].agentId).toBe('agent-2');
      expect(agents[1].completedAt).toBeDefined();

      // Wait for debounced persist to settle before reading from disk
      await new Promise((r) => setTimeout(r, 50));

      // Verify persisted
      const reloaded = await WorkflowStatusTracker.load(dir);
      expect(reloaded.spawnedAgents).toHaveLength(2);
    });

    it('spawnedAgents persists alongside other workflow state', async () => {
      tracker.setTaskPrompt('Full state test');
      tracker.setPhase('implementing');
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentSpawn('agent-2', 'reviewer', 'planning', 'task-1');
      tracker.recordAgentComplete('agent-1');
      tracker.addTokensToStats({ input: 100, output: 50 });
      tracker.incrementAgentCount();

      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskPrompt).toBe('Full state test');
      expect(restored.currentPhase).toBe('implementing');
      expect(restored.spawnedAgents).toHaveLength(2);
      expect(restored.stats.totalTokens).toBe(150);
    });
  });

  // ── auto-persist on agent spawn ────────────────────────────────────

  describe('auto-persist on agent spawn/complete', () => {
    it('spawn triggers auto-persist to disk', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toHaveLength(1);
      expect(restored.spawnedAgents[0].agentId).toBe('agent-1');
    });

    it('complete triggers auto-persist to disk', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      await new Promise((r) => setTimeout(r, 50));

      tracker.recordAgentComplete('agent-1');
      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents[0].completedAt).toBeDefined();
    });
  });

  // ── PersistedAgentRecord type validation ───────────────────────────

  describe('PersistedAgentRecord shape', () => {
    it('records match the PersistedAgentRecord interface shape', () => {
      tracker.recordAgentSpawn('a1', 'coder', 'scouting', 't1');
      const record: PersistedAgentRecord = tracker.spawnedAgents[0];

      // Verify all fields exist with correct types
      expect(typeof record.agentId).toBe('string');
      expect(typeof record.profile).toBe('string');
      expect(typeof record.phase).toBe('string');
      expect(typeof record.taskId).toBe('string');
      expect(record.completedAt).toBeUndefined();

      // Complete it and verify completedAt is set
      tracker.recordAgentComplete('a1');
      const completed: PersistedAgentRecord = tracker.spawnedAgents[0];
      expect(typeof completed.completedAt).toBe('string');
    });

    it('all SpawnedAgents in WorkflowState JSON match PersistedAgentRecord', async () => {
      tracker.recordAgentSpawn('a1', 'coder', 'scouting', 't1');
      tracker.recordAgentSpawn('a2', 'reviewer', 'planning');
      tracker.recordAgentComplete('a1');

      await tracker.save();
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);

      expect(data.spawnedAgents).toBeDefined();
      expect(Array.isArray(data.spawnedAgents)).toBe(true);

      for (const record of data.spawnedAgents) {
        expect(typeof record.agentId).toBe('string');
        expect(typeof record.profile).toBe('string');
        expect(typeof record.phase).toBe('string');
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
      tracker.recordAgentSpawn({ agentId: 'agent-obj-1', profile: 'coder', phase: 'scouting', taskId: 'task-99' });

      const agents = tracker.spawnedAgents;
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('agent-obj-1');
      expect(agents[0].profile).toBe('coder');
      expect(agents[0].phase).toBe('scouting');
      expect(agents[0].taskId).toBe('task-99');
      expect(agents[0].completedAt).toBeUndefined();
    });

    it('accepts an object without optional taskId', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-obj-2', profile: 'reviewer', phase: 'planning' });

      const agents = tracker.spawnedAgents;
      expect(agents).toHaveLength(1);
      expect(agents[0].taskId).toBeUndefined();
    });

    it('persists via debounced auto-persist', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-obj-3', profile: 'coder', phase: 'implementing' });

      // Wait for debounced persist
      await new Promise((r) => setTimeout(r, 50));

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
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      const elapsed = performance.now() - start;

      // A sync file write would typically take >1ms; a synchronous in-memory op
      // should be sub-millisecond. We use a generous threshold to avoid flakiness.
      expect(elapsed).toBeLessThan(5);

      // In-memory state is immediately available
      expect(tracker.spawnedAgents).toHaveLength(1);
    });

    it('recordAgentComplete returns synchronously without blocking for I/O', () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      const start = performance.now();
      tracker.recordAgentComplete('agent-1');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5);

      // In-memory state is immediately available
      expect(tracker.spawnedAgents[0].completedAt).toBeDefined();
    });

    it('multiple rapid spawn calls are coalesced into fewer disk writes', async () => {
      // Rapidly spawn multiple agents
      for (let i = 0; i < 5; i++) {
        tracker.recordAgentSpawn(`agent-${i}`, 'coder', 'implementing', `task-${i}`);
      }

      // All 5 should be in memory immediately
      expect(tracker.spawnedAgents).toHaveLength(5);

      // Wait for debounced persist to settle
      await new Promise((r) => setTimeout(r, 50));

      // All 5 should be persisted in a single file
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(data.spawnedAgents[i].agentId).toBe(`agent-${i}`);
      }
    });

    it('spawn immediately followed by complete persists both', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      tracker.recordAgentComplete('agent-1');

      // In-memory state reflects both operations
      expect(tracker.spawnedAgents).toHaveLength(1);
      expect(tracker.spawnedAgents[0].completedAt).toBeDefined();

      // Wait for debounced persist
      await new Promise((r) => setTimeout(r, 50));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
      expect(data.spawnedAgents[0].completedAt).toBeDefined();
    });

    it('debounced persist writes to disk after microtick', async () => {
      // Ensure no state file exists yet
      await expect(fs.access(join(dir, '.engin-state.json'))).rejects.toThrow();

      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      // The debounced persist schedules a save on the next microtask.
      // After a short delay, the file should exist on disk.
      await new Promise((r) => setTimeout(r, 50));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(1);
    });

    it('source does not import sync fs functions or contain persistStateSync', async () => {
      // Structural test: verify the source was refactored to remove sync I/O.
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
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
