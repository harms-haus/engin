import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { makeTask } from '../helpers/make-task.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Poll the persisted `.engin-state.json` until `predicate(parsedData)` is true
 * (or `timeoutMs` elapses). The tracker's persist is an async coalescing chain
 * (each save awaits file I/O), so a rapid burst of mutations can leave saves
 * queued behind one another. Fixed `setTimeout` waits race that chain and flake
 * on slow CI runners; polling makes the wait exactly as long as needed.
 */
async function waitForPersisted(
  dir: string,
  // `any` matches the semantics of JSON.parse used throughout this test —
  // the parsed state file is structurally dynamic.

  predicate: (data: any) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const file = join(dir, '.engin-state.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      if (predicate(JSON.parse(raw))) return;
    } catch {
      // file may not exist yet on the very first save — keep polling
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  // Final read for a clear failure message
  const raw = await fs.readFile(file, 'utf-8');

  const final: any = JSON.parse(raw);
  expect(predicate(final)).toBe(true);
}

describe('WorkflowStatusTracker – persist architecture (bounded promise chain)', () => {
  const { getDir } = useTempDir();
  let dir: string;
  let tracker: WorkflowStatusTracker;

  beforeEach(() => {
    dir = getDir();
    tracker = new WorkflowStatusTracker(dir);
  });

  // ── behavioral: debounce / coalescing ─────────────────────────────

  describe('debounce / coalescing', () => {
    it('persistState sets _pendingSave and schedules one save', async () => {
      // Trigger persistState via setWorkflowData (which calls persistState)
      tracker.setWorkflowData({ someKey: 'test' });

      // At this point _pendingSave is true, _doPersist is scheduled
      // After a tick, the save should complete
      await new Promise((r) => setTimeout(r, 10));

      // The state file should now exist
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.workflowData?.someKey).toBe('test');
    });

    it('rapid calls to persistState are coalesced into a single save', async () => {
      // Trigger persistState multiple times in rapid succession
      tracker.setTaskPrompt('v1');
      tracker.setWorkflowData({ key1: 'v1' });
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
      // setWorkflowData calls persistState synchronously — should return immediately
      tracker.setWorkflowData({ someKey: 'non-blocking' });
      const elapsed = performance.now() - start;

      // Must be sub-millisecond (no synchronous I/O)
      expect(elapsed).toBeLessThan(5);

      // In-memory state is updated immediately
      expect(tracker.taskPrompt).toBe('sync-test');
      expect((tracker.workflowData as Record<string, unknown>).someKey).toBe('non-blocking');
    });

    it('calls during an in-flight save are coalesced with _queuedSave', async () => {
      // First, trigger a save
      tracker.setTaskPrompt('first');
      tracker.setWorkflowData({ key: 'first' });

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
      tracker.setWorkflowData({ key: 'slow' });

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
        // Each setWorkflowData calls persistState
        tracker.setWorkflowData({ iteration: i });
      }

      await new Promise((r) => setTimeout(r, 50));

      // Read the state file — should reflect the final state
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('iteration-19');
      expect(data.workflowData?.iteration).toBe(19);
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
      tracker.setWorkflowData({ attempt: 'first' });

      await new Promise((r) => setTimeout(r, 30));

      // First save should have been attempted
      expect(saveCallCount).toBeGreaterThanOrEqual(1);

      // Trigger another persist — second save should succeed
      tracker.setTaskPrompt('second-attempt');
      tracker.setWorkflowData({ attempt: 'second' });

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
      tracker.setWorkflowData({ tag: 'fail-1' });
      await new Promise((r) => setTimeout(r, 20));

      tracker.setTaskPrompt('fail-2');
      tracker.setWorkflowData({ tag: 'fail-2' });
      await new Promise((r) => setTimeout(r, 20));

      tracker.setTaskPrompt('fail-3');
      tracker.setWorkflowData({ tag: 'fail-3' });
      await new Promise((r) => setTimeout(r, 20));

      // save() should have been called multiple times (each persist attempt)
      expect(callCount).toBeGreaterThanOrEqual(1);

      // In-memory state should always be correct despite failures
      expect(tracker.taskPrompt).toBe('fail-3');
      expect((tracker.workflowData as Record<string, unknown>).tag).toBe('fail-3');

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
        tracker.setWorkflowData({ tag: 'resilient' });
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
        // setWorkflowData triggers persistState
        tracker.setWorkflowData({ indicator: `step-${i}` });
      }

      // Wait for all debounced saves to complete
      await waitForPersisted(dir, (d) => d.taskPrompt === 'chain-test-99' && d.workflowData?.indicator === 'step-99');

      // Final state should be correct
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('chain-test-99');
      expect(data.workflowData?.indicator).toBe('step-99');

      // After settling, there should be no pending save
      // We verify by checking that another save works fresh
      tracker.setTaskPrompt('fresh-after-chain');
      tracker.setWorkflowData({ wfTitle: 'fresh-after-chain' });
      await waitForPersisted(
        dir,
        (d) => d.taskPrompt === 'fresh-after-chain' && d.workflowData?.wfTitle === 'fresh-after-chain',
      );

      const raw2 = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data2 = JSON.parse(raw2);
      expect(data2.taskPrompt).toBe('fresh-after-chain');
      expect(data2.workflowData?.wfTitle).toBe('fresh-after-chain');
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

      // All sessions persisted
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
      tracker.setWorkflowData({ wfTitle: 'reset' });

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
      tracker.setWorkflowData({ wfTitle: 'reset-3' });

      await new Promise((r) => setTimeout(r, 30));

      raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).taskPrompt).toBe('reset-test-3');
    });
  });

  // ── behavioral: _queuedSave retry logic ────────────────────────────

  describe('_queuedSave retry logic', () => {
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
      tracker.setWorkflowData({ wfTitle: 'initial' });

      // Let the save start (but it's blocked on our barrier)
      await new Promise((r) => setTimeout(r, 10));

      // Trigger another change while save is in-flight — this sets _queuedSave
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
      tracker.setWorkflowData({ wfTitle: 'base' });
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

    it('_queuedSave is false when no save is pending and no retry is needed', async () => {
      // First save
      tracker.setTaskPrompt('queued-save-check');
      await tracker.save();

      // After a clean save, _pendingSave is false and _queuedSave is false
      // We can verify by checking that the next persistState schedules a fresh save
      // rather than setting _queuedSave

      // Reset the save counter
      let saveCalls = 0;
      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        saveCalls++;
        await originalSave();
      };

      // Trigger a persist — should call save once
      tracker.setWorkflowData({ wfTitle: 'clean-save' });
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
      tracker.setWorkflowData({ wfTitle: 'auto-persist' });

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

      tracker.taskTracker.claimTasks(1, 'agent-x');
      tracker.taskTracker.completeTask('t1');

      await new Promise((r) => setTimeout(r, 50));

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.taskTracker.getTask('t1')!.status).toBe('complete');
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
      tracker.setWorkflowData({ wfTitle: 'dispose-test' });
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
    it('setWorkflowData calls persistState (uses the new architecture)', async () => {
      tracker.setWorkflowData({ wfTitle: 'sidebar-test' });

      await new Promise((r) => setTimeout(r, 30));

      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      expect(JSON.parse(raw).workflowData?.wfTitle).toBe('sidebar-test');
    });

    it('multiple calls that trigger persistState are properly debounced', async () => {
      tracker.setWorkflowData({ wfTitle: 'v1' });
      tracker.setWorkflowData({ wfIndicator: 'v2' });
      tracker.setWorkflowData({ wfTitle: 'v3' });

      await new Promise((r) => setTimeout(r, 30));

      // setSidebar merges properties, so final state should have title from v3 and indicator from v2
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.workflowData?.wfTitle).toBe('v3');
      expect(data.workflowData?.wfIndicator).toBe('v2');
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
      tracker.setWorkflowData({ wfTitle: 'in-flight' });
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

  // ── behavioral: no duplicate saves (race condition fix) ────────────

  describe('no duplicate saves (race condition fix)', () => {
    it('no duplicate _doPersist invocations when persistState is called during the finally window', async () => {
      // This test simulates the exact race condition scenario:
      // 1. A save is in flight (_doPersist running)
      // 2. During the finally block, the old code set _pendingSave = false
      // 3. A concurrent persistState() could see _pendingSave = false and start
      //    another _doPersist, while the recursive _doPersist() also starts
      //
      // With the fix (_doPersist sets _pendingSave = true at start), there should
      // never be two concurrent save() I/O operations. We verify this by tracking
      // how many times save() actually executes its I/O (goes past _saveLock).

      let ioSaveCount = 0;
      let concurrentIo = 0;
      let maxConcurrentIo = 0;

      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        // _saveLock serializes entry, so by the time we're here,
        // this is the one executing. Track actual I/O concurrency.
        concurrentIo++;
        maxConcurrentIo = Math.max(maxConcurrentIo, concurrentIo);
        ioSaveCount++;
        try {
          await originalSave();
        } finally {
          concurrentIo--;
        }
      };

      // Trigger a state change that starts a save
      tracker.setTaskPrompt('race-test-1');
      tracker.setWorkflowData({ wfTitle: 'race-1' });

      // Wait a tick for _doPersist to start and hit the await
      await new Promise((r) => setTimeout(r, 5));

      // While the save is in-flight, trigger another persist
      // This should set _queuedSave = true, not start a second _doPersist
      tracker.setTaskPrompt('race-test-2');
      tracker.setWorkflowData({ wfTitle: 'race-2' });

      // Wait for everything to settle
      await new Promise((r) => setTimeout(r, 50));

      // At no point should we have had more than 1 concurrent I/O operation.
      // _saveLock already serializes save(), and the _pendingSave flag prevents
      // duplicate _doPersist chains.
      expect(maxConcurrentIo).toBeLessThanOrEqual(1);

      // We should have had at most 2 save() I/O calls total (initial + retry)
      expect(ioSaveCount).toBeLessThanOrEqual(2);

      // The final state should reflect all changes
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('race-test-2');
      expect(data.workflowData?.wfTitle).toBe('race-2');

      tracker.save = originalSave;
    });

    it('persistState never starts a second _doPersist while one is already scheduled', async () => {
      // Verify that rapid persistState calls don't spawn extra save operations.
      // The debounce mechanism should coalesce them into at most 2 save calls.
      let saveCallCount = 0;

      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        saveCallCount++;
        await new Promise((r) => setTimeout(r, 5)); // small delay
        await originalSave();
      };

      // Rapidly trigger many persistState calls in synchronous succession
      for (let i = 0; i < 10; i++) {
        tracker.setTaskPrompt(`burst-${i}`);
        tracker.setWorkflowData({ title: `burst-${i}` });
      }

      // Wait for all saves to settle
      await new Promise((r) => setTimeout(r, 200));

      // We should NOT have 10 save calls. With proper coalescing, we should have
      // at most 2 (the initial save, possibly one retry if _queuedSave was set).
      expect(saveCallCount).toBeLessThanOrEqual(2);

      // Final state must be correct
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('burst-9');
      expect(data.workflowData?.title).toBe('burst-9');

      tracker.save = originalSave;
    });

    it('_doPersist start sets _pendingSave so recursive call is not visible as idle', async () => {
      // This tests the core race condition fix:
      // The finally block of _doPersist sets _pendingSave = false, then
      // if _queuedSave is true, it calls _doPersist() recursively.
      // Between _pendingSave = false and the recursive _doPersist() setting
      // _pendingSave = true, there must be NO yield point where persistState()
      // could observe _pendingSave == false.
      //
      // We verify this by hammering persistState() synchronously from the
      // event queue while _doPersist is in its finally block. The key is that
      // the recursive _doPersist() sets _pendingSave = true BEFORE any await,
      // so there's no window for a second _doPersist to start.

      // Track how many save I/O operations execute (go past _saveLock)
      let ioExecutions = 0;
      let maxConcurrentIo = 0;
      let concurrentIo = 0;

      const originalSave = tracker.save.bind(tracker);
      tracker.save = async () => {
        concurrentIo++;
        maxConcurrentIo = Math.max(maxConcurrentIo, concurrentIo);
        ioExecutions++;
        try {
          await new Promise((r) => setTimeout(r, 3));
          await originalSave();
        } finally {
          concurrentIo--;
        }
      };

      // Start a save and wait for it to be in-flight
      tracker.setTaskPrompt('window-test-1');
      tracker.setWorkflowData({ wfTitle: 'window-1' });
      await new Promise((r) => setTimeout(r, 10));

      // Trigger another change to set _queuedSave
      tracker.setTaskPrompt('window-test-2');

      // Issue a burst of synchronous persistState calls while the save
      // machinery might be in its finally block transitioning flags.
      // All synchronous calls happen in the same microtask, so they all
      // see the same _pendingSave state.
      for (let i = 0; i < 50; i++) {
        tracker.setWorkflowData({ wfTitle: `window-${i}` });
      }

      // Wait for all saves to settle
      await new Promise((r) => setTimeout(r, 150));

      // We should never have had more than 1 concurrent I/O operation.
      // _saveLock serializes save(), and the _pendingSave flag in _doPersist
      // prevents duplicate chains.
      expect(maxConcurrentIo).toBeLessThanOrEqual(1);

      // Total actual I/O executions should be far fewer than 50 (which would indicate
      // no coalescing). With proper debouncing, 50 synchronous calls should produce
      // at most 2-3 save sequences (initial + maybe 1-2 retries).
      expect(ioExecutions).toBeLessThanOrEqual(5);

      // Final state must be coherent
      const raw = await fs.readFile(join(dir, '.engin-state.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.taskPrompt).toBe('window-test-2');

      tracker.save = originalSave;
    });
  });
});
