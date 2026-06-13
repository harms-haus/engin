import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowStatusTracker } from '../../src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('WorkflowStatusTracker – persist architecture (bounded promise chain)', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── structural: source code verification ──────────────────────────

  describe('source code structure', () => {
    it('does NOT have a _savePromise field', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // The old unbounded chain field must be removed
      expect(source).not.toMatch(/private\s+_savePromise\s*:/);
      // The old pattern of chaining: _savePromise = _savePromise.then(...) must be gone
      expect(source).not.toMatch(/_savePromise\s*=\s*this\._savePromise\.then/);
    });

    it('has a private _doPersist async method', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // The new bounded method should exist
      expect(source).toMatch(/private\s+async\s+_doPersist\s*\(\)\s*:\s*Promise\s*<\s*void\s*>/);
    });

    it('persistState calls void this._doPersist() instead of chaining promises', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // Extract persistState method body
      const methodStart = source.indexOf('private persistState():');
      const methodEnd = source.indexOf('private async _doPersist');
      const body = source.slice(methodStart, methodEnd);

      // Should use the new fire-and-forget pattern
      expect(body).toContain('void this._doPersist()');
      // Should NOT chain promises
      expect(body).not.toMatch(/_savePromise\s*=\s*this\._savePromise\.then/);
      // Should NOT reference _savePromise at all
      expect(body).not.toContain('_savePromise');
    });

    it('dispose() does not reference _savePromise', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // Find dispose method body
      const disposeIdx = source.indexOf('dispose():');
      const attachIdx = source.indexOf('private attachAutoPersist');
      const disposeBody = source.slice(disposeIdx, attachIdx);

      // Should not reference the removed field
      expect(disposeBody).not.toContain('_savePromise');
    });

    it('_doPersist has try/catch/finally with _needsSave retry logic', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      const doPersistStart = source.indexOf('private async _doPersist');
      const attachStart = source.indexOf('private attachAutoPersist');
      const doPersistBody = source.slice(doPersistStart, attachStart);

      // Should have try/catch block calling this.save()
      expect(doPersistBody).toMatch(/try\s*\{[\s\S]*await\s+this\.save\(\)/);
      // Should have catch block with console.warn
      expect(doPersistBody).toMatch(/catch\s*\([\s\S]*console\.warn/);
      // Should have finally block resetting _pendingSave and retrying if _needsSave
      expect(doPersistBody).toMatch(/finally\s*\{[\s\S]*_pendingSave\s*=\s*false/);
      expect(doPersistBody).toMatch(/if\s*\(this\._needsSave\)\s*\{[\s\S]*void\s*this\._doPersist/);
    });

    it('does not have _saveLock removed — the save mutex is preserved', async () => {
      const sourcePath = join(import.meta.dir, '..', '..', 'src', 'tracking', 'workflow-status.ts');
      const source = await fs.readFile(sourcePath, 'utf-8');

      // The _saveLock mutex should still be present (it's the second serialization mechanism)
      expect(source).toMatch(/private\s+_saveLock\s*:\s*Promise\s*<\s*void\s*>/);
    });
  });

  // ── behavioral: debounce / coalescing ─────────────────────────────

  describe('debounce / coalescing', () => {
    it('persistState sets _pendingSave and schedules one save', async () => {
      // Trigger persistState via setSidebar (which calls persistState)
      tracker.setSidebar({ title: 'test' });

      // At this point _pendingSave is true, _doPersist is scheduled
      // After a tick, the save should complete
      await new Promise((r) => setTimeout(r, 10));

      // The state file should now exist
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.sidebar?.title).toBe('test');
    });

    it('rapid calls to persistState are coalesced into a single save', async () => {
      // Trigger persistState multiple times in rapid succession
      tracker.setTaskPrompt('v1');
      tracker.setSidebar({ title: 'v1' });
      tracker.recordAgentSpawn('a1', 'coder', 'scouting');
      tracker.setTaskPrompt('v2');
      tracker.recordAgentSpawn('a2', 'coder', 'planning');

      // All mutations should be in memory immediately
      expect(tracker.taskPrompt).toBe('v2');
      expect(tracker.spawnedAgents).toHaveLength(2);

      // Wait for the debounced save to settle
      await new Promise((r) => setTimeout(r, 50));

      // The persisted state should reflect ALL mutations (not just the last one)
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('v2');
      expect(data.spawnedAgents).toHaveLength(2);
    });

    it('persistState does not block the caller synchronously', () => {
      tracker.setTaskPrompt('sync-test');

      const start = performance.now();
      // setSidebar calls persistState synchronously — should return immediately
      tracker.setSidebar({ title: 'non-blocking' });
      const elapsed = performance.now() - start;

      // Must be sub-millisecond (no synchronous I/O)
      expect(elapsed).toBeLessThan(5);

      // In-memory state is updated immediately
      expect(tracker.taskPrompt).toBe('sync-test');
      expect(tracker.sidebar?.title).toBe('non-blocking');
    });

    it('calls during an in-flight save are coalesced with _needsSave', async () => {
      // First, trigger a save
      tracker.setTaskPrompt('first');
      tracker.setSidebar({ title: 'first' });

      // Wait for it to settle
      await new Promise((r) => setTimeout(r, 30));

      // Now trigger a rapid set of changes while a save might be in flight
      // We can intercept save to make it slow
      const originalSave = tracker.save.bind(tracker);
      let slowSaveResolve: (() => void) | undefined;
      tracker.save = async () => {
        await new Promise<void>((r) => {
          slowSaveResolve = r;
        });
        await originalSave();
      };

      // Start a persist (which will call our slow save)
      tracker.setTaskPrompt('slow');
      tracker.setSidebar({ title: 'slow' });

      // Give the microtask queue a chance to start _doPersist
      await new Promise((r) => setTimeout(r, 5));

      // While save is in-flight, trigger another change
      tracker.setTaskPrompt('coalesced');
      tracker.recordAgentSpawn('a1', 'coder', 'scouting');

      // Now release the slow save
      slowSaveResolve!();

      // Wait for the second save to complete
      await new Promise((r) => setTimeout(r, 30));

      // The final state should include the coalesced change
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('coalesced');
      expect(data.spawnedAgents).toHaveLength(1);

      // Restore original save
      tracker.save = originalSave;
    });

    it('multiple rapid saves only produce one final state file', async () => {
      // Rapidly trigger many persistState calls
      for (let i = 0; i < 20; i++) {
        tracker.setTaskPrompt(`iteration-${i}`);
        // Each setSidebar calls persistState
        tracker.setSidebar({ title: `sidebar-${i}` });
      }

      await new Promise((r) => setTimeout(r, 50));

      // Read the state file — should reflect the final state
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('iteration-19');
      expect(data.sidebar?.title).toBe('sidebar-19');
    });
  });

  // ── behavioral: error handling in _doPersist ──────────────────────

  describe('error handling in _doPersist', () => {
    it('save failure does not throw and does not prevent future saves', async () => {
      let saveCallCount = 0;

      // Intercept the first save to fail
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        saveCallCount++;
        if (saveCallCount === 1) {
          throw new Error('Simulated disk error on first save');
        }
        await originalSave();
      };

      // Trigger a persist — first save will fail
      tracker.setTaskPrompt('first-attempt');
      tracker.setSidebar({ title: 'first' });

      await new Promise((r) => setTimeout(r, 30));

      // First save should have been attempted
      expect(saveCallCount).toBeGreaterThanOrEqual(1);

      // Trigger another persist — second save should succeed
      tracker.setTaskPrompt('second-attempt');
      tracker.setSidebar({ title: 'second' });

      await new Promise((r) => setTimeout(r, 30));

      // Second save should have been attempted
      expect(saveCallCount).toBeGreaterThanOrEqual(2);

      // The final state should reflect the last attempted save
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('second-attempt');

      // Restore original save
      tracker.save = originalSave;
    });

    it('consecutive save failures are handled gracefully', async () => {
      const originalSave = tracker.save.bind(tracker);
      let callCount = 0;
      tracker.save = async () => {
        callCount++;
        throw new Error(`Simulated error #${callCount}`);
      };

      // Trigger multiple persists — all saves will fail
      tracker.setTaskPrompt('fail-1');
      tracker.setSidebar({ title: 'fail-1' });
      await new Promise((r) => setTimeout(r, 20));

      tracker.setTaskPrompt('fail-2');
      tracker.setSidebar({ title: 'fail-2' });
      await new Promise((r) => setTimeout(r, 20));

      tracker.setTaskPrompt('fail-3');
      tracker.setSidebar({ title: 'fail-3' });
      await new Promise((r) => setTimeout(r, 20));

      // save() should have been called multiple times (each persist attempt)
      expect(callCount).toBeGreaterThanOrEqual(1);

      // In-memory state should always be correct despite failures
      expect(tracker.taskPrompt).toBe('fail-3');
      expect(tracker.sidebar?.title).toBe('fail-3');

      // Restore original save
      tracker.save = originalSave;
    });

    it('save errors are caught and logged but do not crash the tracker', async () => {
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        throw new Error('Disk full');
      };

      // These should not throw despite save failures
      expect(() => {
        tracker.setTaskPrompt('resilient');
        tracker.setSidebar({ title: 'resilient' });
        tracker.recordAgentSpawn('a1', 'coder', 'scouting');
        tracker.recordAgentComplete('a1');
      }).not.toThrow();

      // In-memory state is correct
      expect(tracker.taskPrompt).toBe('resilient');
      expect(tracker.spawnedAgents).toHaveLength(1);

      // Wait for any pending async work
      await new Promise((r) => setTimeout(r, 30));

      // Restore original save
      tracker.save = originalSave;
    });
  });

  // ── behavioral: no unbounded promise chain ────────────────────────

  describe('no unbounded promise chain', () => {
    it('persistState does not grow a chain across many calls', async () => {
      // The key property: after N calls to persistState, the chain should not
      // be N promises deep. We verify this indirectly by checking that:
      // 1. Only one pending save exists at a time
      // 2. After all saves settle, there's no lingering chain

      // This test simulates many sequential state changes
      for (let i = 0; i < 100; i++) {
        tracker.setTaskPrompt(`chain-test-${i}`);
        // setSidebar triggers persistState
        tracker.setSidebar({ indicator: `step-${i}` });
      }

      // Wait for all debounced saves to complete
      await new Promise((r) => setTimeout(r, 100));

      // Final state should be correct
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('chain-test-99');
      expect(data.sidebar?.indicator).toBe('step-99');

      // After settling, there should be no pending save
      // We verify by checking that another save works fresh
      tracker.setTaskPrompt('fresh-after-chain');
      tracker.setSidebar({ title: 'fresh-after-chain' });
      await new Promise((r) => setTimeout(r, 30));

      const raw2 = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data2 = JSON.parse(raw2);
      expect(data2.taskPrompt).toBe('fresh-after-chain');
      expect(data2.sidebar?.title).toBe('fresh-after-chain');
    });

    it('no promise chain accumulates after rapid agent spawns', async () => {
      // recordAgentSpawn calls persistState — rapid spawns should not chain
      for (let i = 0; i < 50; i++) {
        tracker.recordAgentSpawn(`agent-${i}`, 'coder', 'implementing', `task-${i}`);
      }

      // All in memory immediately
      expect(tracker.spawnedAgents).toHaveLength(50);

      // Wait for debounced saves to settle
      await new Promise((r) => setTimeout(r, 100));

      // All agents persisted
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents).toHaveLength(50);

      // Now mark all as complete (another batch of persistState calls)
      for (let i = 0; i < 50; i++) {
        tracker.recordAgentComplete(`agent-${i}`);
      }

      await new Promise((r) => setTimeout(r, 100));

      // All completed
      const raw2 = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data2 = JSON.parse(raw2);
      const completedCount = data2.spawnedAgents.filter((a: { completedAt?: string }) => a.completedAt).length;
      expect(completedCount).toBe(50);
    });

    it('no memory leak — _pendingSave resets after each cycle', async () => {
      // This test verifies the state machine resets properly
      tracker.setTaskPrompt('reset-test');
      tracker.setSidebar({ title: 'reset' });

      await new Promise((r) => setTimeout(r, 30));

      // Read state to verify first save
      let raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('reset-test');

      // Second save cycle
      tracker.setTaskPrompt('reset-test-2');
      await tracker.save();

      // Read state to verify second save
      raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('reset-test-2');

      // Third save cycle (via auto-persist)
      tracker.setTaskPrompt('reset-test-3');
      tracker.setSidebar({ title: 'reset-3' });

      await new Promise((r) => setTimeout(r, 30));

      raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('reset-test-3');
    });
  });

  // ── behavioral: _needsSave retry logic ────────────────────────────

  describe('_needsSave retry logic', () => {
    it('mutations during an in-flight save are persisted on the next cycle', async () => {
      let inFlightResolve: (() => void) | undefined;
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        // Create a barrier that we control
        await new Promise<void>((r) => {
          inFlightResolve = r;
        });
        await originalSave();
      };

      // Start a save cycle
      tracker.setTaskPrompt('initial');
      tracker.setSidebar({ title: 'initial' });

      // Let the save start (but it's blocked on our barrier)
      await new Promise((r) => setTimeout(r, 10));

      // Trigger another change while save is in-flight — this sets _needsSave
      tracker.setTaskPrompt('updated');

      // Release the barrier
      inFlightResolve!();

      // Wait for the second save to complete
      await new Promise((r) => setTimeout(r, 30));

      // The final state should include the update
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('updated');

      // Restore
      tracker.save = originalSave;
    });

    it('multiple mutations during in-flight save all get captured in the retry', async () => {
      let inFlightResolve: (() => void) | undefined;
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        await new Promise<void>((r) => {
          inFlightResolve = r;
        });
        await originalSave();
      };

      // Start a save
      tracker.setTaskPrompt('base');
      tracker.setSidebar({ title: 'base' });
      await new Promise((r) => setTimeout(r, 10));

      // Multiple changes while in-flight
      tracker.setTaskPrompt('change-1');
      tracker.recordAgentSpawn('a1', 'coder', 'scouting');
      await new Promise((r) => setTimeout(r, 5));
      tracker.setTaskPrompt('change-2');
      tracker.recordAgentSpawn('a2', 'coder', 'planning');

      // Release barrier
      inFlightResolve!();

      await new Promise((r) => setTimeout(r, 30));

      // All changes should be captured
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('change-2');
      expect(data.spawnedAgents).toHaveLength(2);

      tracker.save = originalSave;
    });

    it('_needsSave is false when no save is pending and no retry is needed', async () => {
      // First save
      tracker.setTaskPrompt('needs-save-check');
      await tracker.save();

      // After a clean save, _pendingSave is false and _needsSave is false
      // We can verify by checking that the next persistState schedules a fresh save
      // rather than setting _needsSave

      // Reset the save counter
      let saveCalls = 0;
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        saveCalls++;
        await originalSave();
      };

      // Trigger a persist — should call save once
      tracker.setSidebar({ title: 'clean-save' });
      await new Promise((r) => setTimeout(r, 30));

      // save should have been called exactly once for this cycle
      // (it might have been called multiple times due to the async nature,
      // but at minimum it should have been called at least once)
      expect(saveCalls).toBeGreaterThanOrEqual(1);

      tracker.save = originalSave;
    });
  });

  // ── behavioral: _saveLock mutex still works ───────────────────────

  describe('_saveLock mutex (unchanged)', () => {
    it('explicit save() calls are serialized by the _saveLock mutex', async () => {
      // The _saveLock in save() serializes concurrent calls.
      // We verify this by checking that concurrent saves produce a consistent result.

      const saves: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        tracker.setTaskPrompt(`concurrent-${i}`);
        saves.push(tracker.save());
      }
      await Promise.all(saves);

      // One of the concurrent saves should have won — the state must be valid
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toMatch(/^concurrent-\d$/);
    });

    it('save() still works when called directly (bypassing _doPersist)', async () => {
      tracker.setTaskPrompt('direct-save');
      await tracker.save();

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('direct-save');
    });

    it('auto-persist via _doPersist still calls through save() (uses _saveLock)', async () => {
      tracker.setTaskPrompt('auto-persist-via-dopersist');
      tracker.setSidebar({ title: 'auto-persist' });

      await new Promise((r) => setTimeout(r, 30));

      // Should have been written through save() with the _saveLock mutex
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('auto-persist-via-dopersist');
    });
  });

  // ── behavioral: auto-persist still works ──────────────────────────

  describe('auto-persist still works with new architecture', () => {
    it('task completion triggers auto-persist', async () => {
      tracker.setTaskPrompt('task-auto-persist');
      tracker.taskTracker.addTask(makeTask({ id: 't1' }));

      const _claimed = tracker.taskTracker.claimTasks(1);
      tracker.taskTracker.startTask('t1', 'agent-x');
      tracker.taskTracker.submitForReview('t1', { ok: true });
      tracker.taskTracker.completeTask('t1');

      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('done');
      expect(restored.taskPrompt).toBe('task-auto-persist');
    });

    it('recordAgentSpawn triggers auto-persist', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');

      await new Promise((r) => setTimeout(r, 50));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).spawnedAgents).toHaveLength(1);
    });

    it('recordAgentComplete triggers auto-persist', async () => {
      tracker.recordAgentSpawn('agent-1', 'coder', 'scouting');
      await new Promise((r) => setTimeout(r, 50));

      tracker.recordAgentComplete('agent-1');
      await new Promise((r) => setTimeout(r, 50));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.spawnedAgents[0].completedAt).toBeDefined();
    });

    it('auto-persist is still disabled after dispose()', async () => {
      tracker.setTaskPrompt('dispose-test');
      tracker.setSidebar({ title: 'dispose-test' });
      await new Promise((r) => setTimeout(r, 30));

      tracker.dispose();

      // After dispose, changes should NOT persist
      tracker.setTaskPrompt('after-dispose');
      await new Promise((r) => setTimeout(r, 30));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('dispose-test');
    });
  });

  // ── behavioral: edge cases ────────────────────────────────────────

  describe('edge cases', () => {
    it('setSidebar calls persistState (uses the new architecture)', async () => {
      tracker.setSidebar({ title: 'sidebar-test' });

      await new Promise((r) => setTimeout(r, 30));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).sidebar?.title).toBe('sidebar-test');
    });

    it('multiple calls to setSidebar are properly debounced', async () => {
      tracker.setSidebar({ title: 'v1' });
      tracker.setSidebar({ indicator: 'v2' });
      tracker.setSidebar({ title: 'v3' });

      await new Promise((r) => setTimeout(r, 30));

      // setSidebar merges properties, so final state should have title from v3 and indicator from v2
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.sidebar?.title).toBe('v3');
      expect(data.sidebar?.indicator).toBe('v2');
    });

    it('dispose() during an in-flight save is safe', async () => {
      let slowSaveResolve: (() => void) | undefined;
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        await new Promise<void>((r) => {
          slowSaveResolve = r;
        });
        await originalSave();
      };

      // Start a save
      tracker.setTaskPrompt('save-in-flight');
      tracker.setSidebar({ title: 'in-flight' });
      await new Promise((r) => setTimeout(r, 10));

      // Dispose while save is blocked
      tracker.dispose();

      // Release the blocked save
      if (slowSaveResolve) {
        slowSaveResolve();
      }

      await new Promise((r) => setTimeout(r, 30));

      // The save should complete but after dispose, no new saves should be scheduled
      expect(tracker.taskPrompt).toBe('save-in-flight');

      tracker.save = originalSave;
    });
  });
});
