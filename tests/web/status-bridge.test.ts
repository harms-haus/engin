import type { ServerMessage } from '@engin/shared/protocol-types';
import { StatusBridge } from '@harms-haus/engin-engine';
import { describe, expect, it } from 'bun:test';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The default runId used by createSetup() when none is supplied. */
const DEFAULT_RUN_ID = 'run-abc-123';

/**
 * Create an EventStore and StatusBridge with a message collector.
 * Uses a small ring buffer so we can test resync-eviction scenarios easily.
 */
function createSetup(opts: { runId?: string; ringBufferSize?: number } = {}) {
  const runId = opts.runId ?? DEFAULT_RUN_ID;
  const ringBufferSize = opts.ringBufferSize ?? 1000;

  const messages: ServerMessage[] = [];
  const broadcast = (msg: ServerMessage) => {
    messages.push(msg);
  };
  const store = new EventStore('/tmp/bridge-test-' + Math.random().toString(36).slice(2), {
    maxRingBuffer: ringBufferSize,
  });
  const bridge = new StatusBridge(broadcast, store, runId);

  /** Clear collected messages. */
  function clear() {
    messages.length = 0;
  }

  /** Get messages of a specific type. */
  function msgs<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  /** Get count of messages of a specific type. */
  function count<T extends ServerMessage['type']>(type: T): number {
    return msgs(type).length;
  }

  /** Flush microtask queue (needed to let coalesced events broadcast). */
  async function flushMicrotasks() {
    await new Promise<void>((r) => queueMicrotask(r));
    // Give the flush a chance to execute
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  return { runId, store, bridge, messages, clear, msgs, count, flushMicrotasks };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StatusBridge', () => {
  // ─── Constructor runId ────────────────────────────────────────────────────

  describe('constructor runId', () => {
    it('accepts a runId string as the third parameter', () => {
      const store = new EventStore('/tmp/bridge-ctor-' + Math.random().toString(36).slice(2));
      expect(() => new StatusBridge(() => {}, store, 'my-run-id')).not.toThrow();
    });
  });

  // ─── getSnapshot ───────────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns { type: "snapshot", runId, seq, state } from a fresh store', () => {
      const { bridge, store, runId } = createSetup();
      const snapshot = bridge.getSnapshot();
      const storeSnap = store.getSnapshot();
      expect(snapshot.type).toBe('snapshot');
      expect(snapshot.runId).toBe(runId);
      expect(snapshot.seq).toBe(storeSnap.seq);
      expect(snapshot.state).toBe(storeSnap.state);
      expect(snapshot.seq).toBe(0);
      expect(snapshot.state.status).toBe('running');
      expect(snapshot.state.currentPhaseId).toBe('');
      expect(snapshot.state.completedPhaseIds).toEqual([]);
      expect(snapshot.state.tasks).toEqual({});
      expect(snapshot.state.agents).toEqual({});
      expect(snapshot.state.sidebar).toEqual({ title: '', indicator: '' });
    });

    it('tags the snapshot with the constructor runId', () => {
      const { bridge, runId } = createSetup({ runId: 'custom-run-42' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.type).toBe('snapshot');
      expect(snapshot.runId).toBe('custom-run-42');
    });

    it('reflects store state after workflow_started', () => {
      const { store, bridge, runId } = createSetup();
      store.append('workflow_started', { taskPrompt: 'Implement login page' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.taskPrompt).toBe('Implement login page');
      expect(snapshot.seq).toBe(1);
      expect(snapshot.runId).toBe(runId);
    });

    it('reflects phase state', () => {
      const { store, bridge } = createSetup();
      store.append('phase_started', { phaseId: 'scouting', round: 1 }, { phaseId: 'scouting' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.currentPhaseId).toBe('scouting');
    });

    it('reflects tasks', () => {
      const { store, bridge } = createSetup();
      store.append('task_registered', {
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      const snapshot = bridge.getSnapshot();
      expect(Object.keys(snapshot.state.tasks)).toHaveLength(1);
      expect(snapshot.state.tasks['t1'].id).toBe('t1');
    });

    it('reflects agents', () => {
      const { store, bridge } = createSetup();
      store.append('agent_spawned', { agentId: 'a1', profile: 'scout' }, { agentId: 'a1', phaseId: 'scouting' });
      const snapshot = bridge.getSnapshot();
      const agentKeys = Object.keys(snapshot.state.agents);
      expect(agentKeys).toHaveLength(1);
      expect(snapshot.state.agents[agentKeys[0]].agentId).toBe('a1');
      expect(snapshot.state.agents[agentKeys[0]].active).toBe(true);
    });

    it('reflects sidebar', () => {
      const { store, bridge } = createSetup();
      store.append('sidebar_updated', { title: 'My Workflow', indicator: '🟢' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.sidebar.title).toBe('My Workflow');
      expect(snapshot.state.sidebar.indicator).toBe('🟢');
    });

    it('always returns the latest state', () => {
      const { store, bridge } = createSetup();
      store.append('workflow_started', { taskPrompt: 'step 1' });
      store.append('phase_started', { phaseId: 'a', round: 1 }, { phaseId: 'a' });
      store.append('phase_completed', { phaseId: 'a', durationMs: 100 }, { phaseId: 'a' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.currentPhaseId).toBe('a');
      expect(snapshot.state.completedPhaseIds).toEqual(['a']);
      expect(snapshot.seq).toBe(3);
    });

    it('different bridges with different runIds tag snapshots independently', () => {
      const store = new EventStore('/tmp/bridge-multi-' + Math.random().toString(36).slice(2));
      const bridgeA = new StatusBridge(() => {}, store, 'run-A');
      const bridgeB = new StatusBridge(() => {}, store, 'run-B');
      expect(bridgeA.getSnapshot().runId).toBe('run-A');
      expect(bridgeB.getSnapshot().runId).toBe('run-B');
      bridgeA.dispose();
      bridgeB.dispose();
    });
  });

  // ─── dispose ───────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('unsubscribe does not throw', () => {
      const { bridge } = createSetup();
      expect(() => bridge.dispose()).not.toThrow();
    });

    it('after dispose, store changes no longer trigger broadcasts', async () => {
      const { store, bridge, count, flushMicrotasks } = createSetup();
      bridge.dispose();
      store.append('sidebar_updated', { title: 'gone' });
      await flushMicrotasks();
      expect(count('events')).toBe(0);
    });
  });

  // ─── dispose guard (uncancellable microtask flushes) ─────────────────────
  //
  // scheduleFlush() defers work via queueMicrotask(), which CANNOT be
  // cancelled.  If dispose() runs between scheduleFlush() and the microtask
  // firing, the pending flush() must become a no-op so it does not broadcast
  // to a dead/unsubscribed store.  Likewise broadcastTerminal() and the
  // projection-change handler must refuse to do work once disposed.
  // Finally, dispose() itself must be idempotent: calling it repeatedly must
  // be safe and must invoke the store unsubscribe only once.

  describe('dispose guard (uncancellable microtask flushes)', () => {
    it('does not flush a pending microtask after dispose', async () => {
      const { store, bridge, count, flushMicrotasks } = createSetup();
      // Appending synchronously schedules a coalesced microtask flush.
      store.append('workflow_started', { taskPrompt: 'race' });
      // Dispose BEFORE the microtask fires — the flush is still queued.
      bridge.dispose();
      await flushMicrotasks();
      // The pending flush must be a no-op: no events broadcast.
      expect(count('events')).toBe(0);
    });

    it('does not flush a coalesced batch after dispose (multiple appends)', async () => {
      const { store, bridge, count, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('sidebar_updated', { title: 'b' });
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' });
      // Dispose before the single coalesced flush microtask fires.
      bridge.dispose();
      await flushMicrotasks();
      expect(count('events')).toBe(0);
    });

    it('does not broadcast terminal lifecycle signals from projection changes (even after dispose)', () => {
      // The bridge never auto-broadcasts terminal messages on projection
      // changes (terminal ownership belongs to the RunManager via
      // broadcastTerminal()).  This holds regardless of dispose state; the
      // assert also guards the disposed-flag path so a re-introduced
      // projection-change terminal detection would still fail this test.
      const { store, bridge, messages } = createSetup();
      bridge.dispose();
      store.append('workflow_failed', { error: 'boom', phase: 'test' });
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
    });

    it('broadcastTerminal(run_complete) is a no-op after dispose', () => {
      const { bridge, messages, runId } = createSetup();
      bridge.dispose();
      bridge.broadcastTerminal({ type: 'run_complete', runId });
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
    });

    it('broadcastTerminal(run_failed) is a no-op after dispose', () => {
      const { bridge, messages, runId } = createSetup();
      bridge.dispose();
      bridge.broadcastTerminal({ type: 'run_failed', runId, error: 'kaboom', phase: 'plan' });
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);
    });

    it('dispose is idempotent — calling it repeatedly does not throw', () => {
      const { bridge } = createSetup();
      expect(() => {
        bridge.dispose();
        bridge.dispose();
        bridge.dispose();
      }).not.toThrow();
    });

    it('dispose is idempotent — store unsubscribe is invoked only once', () => {
      // Wrap store.subscribe so we can count how many times the returned
      // unsubscribe is actually called.  Idempotent dispose() must guard the
      // unsubscribe so repeated dispose() calls do not invoke it more than once.
      const store = new EventStore('/tmp/bridge-idem-' + Math.random().toString(36).slice(2));
      let unsubscribeCalls = 0;
      const realSubscribe = store.subscribe.bind(store);
      store.subscribe = (cb) => {
        const unsub = realSubscribe(cb);
        return () => {
          unsubscribeCalls += 1;
          unsub();
        };
      };

      const bridge = new StatusBridge(() => {}, store, DEFAULT_RUN_ID);
      bridge.dispose();
      bridge.dispose();
      bridge.dispose();

      expect(unsubscribeCalls).toBe(1);
    });

    it('still broadcasts for a fresh sibling bridge created after disposing another', async () => {
      // Regression guard: the disposed flag must be per-instance.  Disposing
      // one bridge must not silence a freshly-created sibling sharing the
      // same store.
      const { store, bridge, runId, flushMicrotasks } = createSetup();
      bridge.dispose();

      const freshMessages: ServerMessage[] = [];
      const fresh = new StatusBridge((m) => freshMessages.push(m), store, runId);
      store.append('sidebar_updated', { title: 'fresh' });
      await flushMicrotasks();

      const freshEvents = freshMessages.filter((m) => m.type === 'events');
      expect(freshEvents).toHaveLength(1);
      expect(freshEvents[0].events).toHaveLength(1);
      fresh.dispose();
    });
  });

  // ─── Event forwarding ─────────────────────────────────────────────────────

  describe('event forwarding', () => {
    it('broadcasts { type: "events" } after appending to the store', async () => {
      const { store, msgs, runId, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'test' });
      await flushMicrotasks();

      const eventsMsgs = msgs('events');
      expect(eventsMsgs).toHaveLength(1);
      expect(eventsMsgs[0].type).toBe('events');
      expect(eventsMsgs[0].runId).toBe(runId);
      expect(eventsMsgs[0].seq).toBe(1);
      expect(eventsMsgs[0].events).toHaveLength(1);
      expect(eventsMsgs[0].events[0].type).toBe('workflow_started');
      expect(eventsMsgs[0].events[0].data.taskPrompt).toBe('test');
    });

    it('forwards raw EventRecords with correct seq', async () => {
      const { store, msgs, runId, flushMicrotasks } = createSetup();
      store.append('phase_started', { phaseId: 'scouting', round: 1 }, { phaseId: 'scouting' });
      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
      expect(events[0].runId).toBe(runId);
      expect(events[0].events[0].seq).toBe(1);
      expect(events[0].events[0].type).toBe('phase_started');
      expect(events[0].events[0].metadata.phaseId).toBe('scouting');
    });

    it('includes all event types in the batch', async () => {
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('sidebar_updated', { title: 'T' });
      store.append('agent_spawned', { agentId: 'a1', profile: 'scout' }, { agentId: 'a1' });
      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
      expect(events[0].events).toHaveLength(3);
      expect(events[0].events[0].type).toBe('workflow_started');
      expect(events[0].events[1].type).toBe('sidebar_updated');
      expect(events[0].events[2].type).toBe('agent_spawned');
    });

    it('sets seq to the latest projection seq', async () => {
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('sidebar_updated', { title: 'b' });
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' });
      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
      // seq is 3 (the third append)
      expect(events[0].seq).toBe(3);
    });
  });

  // ─── Coalescing ───────────────────────────────────────────────────────────

  describe('coalescing', () => {
    it('coalesces multiple synchronous appends into one events message', async () => {
      const { store, msgs, runId, flushMicrotasks } = createSetup();
      // Synchronous appends — should produce only one flush
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('sidebar_updated', { title: 'b' });
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' });

      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
      expect(events[0].events).toHaveLength(3);
      expect(events[0].seq).toBe(3);
      expect(events[0].runId).toBe(runId);
    });

    it('separates flushes across async ticks', async () => {
      const { store, msgs, runId, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' });
      await flushMicrotasks();

      expect(msgs('events')).toHaveLength(1);

      // Second tick
      store.append('sidebar_updated', { title: 'b' });
      await flushMicrotasks();

      expect(msgs('events')).toHaveLength(2);
      expect(msgs('events')[1].events).toHaveLength(1);
      expect(msgs('events')[1].seq).toBe(2);
      expect(msgs('events')[1].runId).toBe(runId);
    });

    it('does not broadcast if no new events since last flush', async () => {
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' });
      await flushMicrotasks();
      expect(msgs('events')).toHaveLength(1);

      // Trigger a flush with nothing new — should not produce a message
      await flushMicrotasks();
      expect(msgs('events')).toHaveLength(1);
    });
  });

  // ─── Late-joiner behaviour ────────────────────────────────────────────────

  describe('late-joiner behaviour', () => {
    it('does not re-broadcast events that happened before bridge construction', async () => {
      // Append events to the store BEFORE creating the bridge
      const store = new EventStore('/tmp/bridge-late-' + Math.random().toString(36).slice(2));
      store.append('workflow_started', { taskPrompt: 'before' });
      store.append('sidebar_updated', { title: 'old' });

      const messages: ServerMessage[] = [];
      const bridge = new StatusBridge((msg) => messages.push(msg), store, DEFAULT_RUN_ID);

      // Flush should not produce events for pre-existing data
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => setTimeout(r, 0));

      const eventsMsgs = messages.filter((m) => m.type === 'events');
      expect(eventsMsgs).toHaveLength(0);

      bridge.dispose();
    });

    it('broadcasts events that happen after bridge construction', async () => {
      const store = new EventStore('/tmp/bridge-late2-' + Math.random().toString(36).slice(2));
      store.append('workflow_started', { taskPrompt: 'before' });

      const messages: ServerMessage[] = [];
      const bridge = new StatusBridge((msg) => messages.push(msg), store, DEFAULT_RUN_ID);

      // New event after bridge creation
      store.append('sidebar_updated', { title: 'after' });

      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => setTimeout(r, 0));

      const eventsMsgs = messages.filter((m) => m.type === 'events');
      expect(eventsMsgs).toHaveLength(1);
      expect(eventsMsgs[0].events).toHaveLength(1);
      expect(eventsMsgs[0].events[0].type).toBe('sidebar_updated');
      expect(eventsMsgs[0].seq).toBe(2);
      expect(eventsMsgs[0].runId).toBe(DEFAULT_RUN_ID);

      bridge.dispose();
    });

    it('getSnapshot returns full state including pre-bridge events', () => {
      const store = new EventStore('/tmp/bridge-late3-' + Math.random().toString(36).slice(2));
      store.append('workflow_started', { taskPrompt: 'history' });
      store.append('phase_started', { phaseId: 'a', round: 1 }, { phaseId: 'a' });

      const bridge = new StatusBridge(() => {}, store, DEFAULT_RUN_ID);
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.taskPrompt).toBe('history');
      expect(snapshot.state.currentPhaseId).toBe('a');
      expect(snapshot.seq).toBe(2);
      expect(snapshot.runId).toBe(DEFAULT_RUN_ID);
      bridge.dispose();
    });
  });

  // ─── Resync ───────────────────────────────────────────────────────────────

  describe('handleResync', () => {
    it('returns events catch-up when lastSeq is within ring buffer', () => {
      const { store, bridge, runId } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' }); // seq 1
      store.append('sidebar_updated', { title: 'b' }); // seq 2
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' }); // seq 3

      const msg = bridge.handleResync(1);
      expect(msg.type).toBe('events');
      if (msg.type === 'events') {
        expect(msg.runId).toBe(runId);
        expect(msg.seq).toBe(3);
        // Should get events with seq > 1
        expect(msg.events).toHaveLength(2);
        expect(msg.events[0].type).toBe('sidebar_updated');
        expect(msg.events[1].type).toBe('phase_started');
      }
    });

    it('returns full snapshot when lastSeq is undefined', () => {
      const { store, bridge, runId } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });

      const msg = bridge.handleResync();
      expect(msg.type).toBe('snapshot');
      if (msg.type === 'snapshot') {
        expect(msg.runId).toBe(runId);
        expect(msg.state.taskPrompt).toBe('x');
        expect(msg.seq).toBe(1);
      }
    });

    it('returns full snapshot when gap is evicted from ring buffer', () => {
      const { store, bridge } = createSetup({ ringBufferSize: 5 }); // tiny ring buffer

      // Append 10 events — the first 5 will be evicted
      for (let i = 0; i < 10; i++) {
        store.append('sidebar_updated', { title: `t${i}` });
      }

      // lastSeq=1 should be evicted (oldest in buffer is seq 6)
      const msg = bridge.handleResync(1);
      expect(msg.type).toBe('snapshot');
      if (msg.type === 'snapshot') {
        expect(msg.runId).toBe(DEFAULT_RUN_ID);
      }
    });

    it('returns snapshot when client is already current (empty buffer)', () => {
      const { bridge } = createSetup();
      // Store is fresh — ring buffer is empty, client says seq 0
      const msg = bridge.handleResync(0);
      expect(msg.type).toBe('snapshot');
    });

    it('returns snapshot when lastSeq matches current seq', () => {
      const { store, bridge } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' }); // seq 1

      const msg = bridge.handleResync(1);
      expect(msg.type).toBe('snapshot');
    });

    it('tags both events and snapshot resync messages with runId', () => {
      const { store, bridge, runId } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' }); // seq 1
      store.append('sidebar_updated', { title: 'b' }); // seq 2

      // events path
      const eventsMsg = bridge.handleResync(1);
      expect(eventsMsg.type).toBe('events');
      if (eventsMsg.type === 'events') {
        expect(eventsMsg.runId).toBe(runId);
      }

      // snapshot path
      const snapMsg = bridge.handleResync();
      expect(snapMsg.type).toBe('snapshot');
      if (snapMsg.type === 'snapshot') {
        expect(snapMsg.runId).toBe(runId);
      }
    });
  });

  // ─── Terminal projection changes are NOT auto-broadcast ──────────────
  //
  // The bridge does NOT detect terminal lifecycle transitions.  Appending a
  // `workflow_completed` / `workflow_failed` event to the store must NOT
  // trigger a `run_complete` / `run_failed` broadcast — that would DUPLICATE
  // the RunManager's explicit `bridge.broadcastTerminal(...)` call, which is
  // the single source of terminal messages.  The terminal event records
  // still travel inside the coalesced `events` batch (idempotent replay),
  // but the dedicated terminal signal is emitted solely by the RunManager.

  describe('terminal projection changes are not auto-broadcast', () => {
    it('does NOT broadcast run_failed when a workflow_failed event is appended', async () => {
      const { store, messages, flushMicrotasks } = createSetup();

      store.append('workflow_failed', { error: 'boom', phase: 'testing' });

      // Synchronous check: no terminal signal (nothing coalesced either).
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);

      // After the microtask flush: still no terminal signal — only the
      // coalesced events batch carries the raw terminal event record.
      await flushMicrotasks();
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);

      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].events[0].type).toBe('workflow_failed');
    });

    it('does NOT broadcast run_complete when a workflow_completed event is appended', async () => {
      const { store, messages, flushMicrotasks } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000 });

      // Synchronous check: no terminal signal.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);

      await flushMicrotasks();
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);

      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].events[0].type).toBe('workflow_completed');
    });

    it('does NOT emit legacy workflow_complete / workflow_failed types', async () => {
      const { store, messages, flushMicrotasks } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000 });
      store.append('workflow_failed', { error: 'boom', phase: 'testing' });
      await flushMicrotasks();

      // ServerMessage never carries the legacy workflow_complete /
      // workflow_failed types, so compare the discriminator as a string.
      const types = messages.map((m) => m.type as string);
      expect(types.filter((t) => t === 'workflow_complete')).toHaveLength(0);
      expect(types.filter((t) => t === 'workflow_failed')).toHaveLength(0);
    });

    it('does not re-broadcast terminal signals on non-lifecycle events', async () => {
      const { store, messages, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('sidebar_updated', { title: 'T' });

      // No terminal signal synchronously, nor after the flush.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);

      await flushMicrotasks();
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);
    });

    it('terminal event records still appear inside the coalesced events batch', async () => {
      // The terminal event records are durable: they are forwarded raw
      // inside the events batch so the web client can replay them via its
      // own evolve.  Only the dedicated run_complete / run_failed SIGNAL is
      // delegated to the RunManager (via broadcastTerminal()).
      const { store, messages, runId, flushMicrotasks } = createSetup();

      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('workflow_completed', { totalDurationMs: 500 });

      await flushMicrotasks();

      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].runId).toBe(runId);
      expect(events[0].events).toHaveLength(2);
      expect(events[0].events[0].type).toBe('workflow_started');
      expect(events[0].events[1].type).toBe('workflow_completed');

      // And critically: no terminal SIGNAL broadcast from the projection change.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
    });
  });

  // ─── broadcastTerminal ─────────────────────────────────────────────────
  //
  // broadcastTerminal() is the canonical hook the RunManager calls when a
  // workflow reaches a terminal lifecycle state.  It must broadcast a
  // run-scoped run_complete / run_failed message tagged with runId
  // IMMEDIATELY (synchronously, not coalesced).

  describe('broadcastTerminal', () => {
    it('immediately broadcasts run_complete tagged with runId', () => {
      const { bridge, messages, runId } = createSetup();

      bridge.broadcastTerminal({ type: 'run_complete', runId });

      const complete = messages.filter((m) => m.type === 'run_complete');
      expect(complete).toHaveLength(1);
      expect(complete[0].runId).toBe(runId);
    });

    it('immediately broadcasts run_failed tagged with runId, error and phase', () => {
      const { bridge, messages, runId } = createSetup();

      bridge.broadcastTerminal({ type: 'run_failed', runId, error: 'kaboom', phase: 'plan' });

      const failed = messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      if (failed[0].type === 'run_failed') {
        expect(failed[0].runId).toBe(runId);
        expect(failed[0].error).toBe('kaboom');
        expect(failed[0].phase).toBe('plan');
      }
    });

    it('broadcasts synchronously (no microtask flush required)', async () => {
      const { bridge, messages, runId, flushMicrotasks } = createSetup();

      bridge.broadcastTerminal({ type: 'run_complete', runId });

      // The message must be present BEFORE any microtask flush.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(1);

      // Flushing must not duplicate the terminal message.
      await flushMicrotasks();
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(1);
    });
  });

  // ─── runId-tagging invariant ───────────────────────────────────────────
  //
  // Every message the bridge emits (snapshot, events, run_complete,
  // run_failed) must be tagged with the constructor-supplied runId.

  describe('runId-tagging invariant', () => {
    it('tags every broadcast message with the constructor runId', async () => {
      const runId = 'tagged-run-99';
      const { store, messages, bridge, flushMicrotasks } = createSetup({ runId });

      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('phase_started', { phaseId: 'scouting', round: 1 }, { phaseId: 'scouting' });
      store.append('workflow_completed', { totalDurationMs: 100 });
      await flushMicrotasks();

      // Every captured message must carry the runId.
      expect(messages.length).toBeGreaterThan(0);
      for (const msg of messages) {
        if (
          msg.type === 'snapshot' ||
          msg.type === 'events' ||
          msg.type === 'run_complete' ||
          msg.type === 'run_failed'
        ) {
          expect(msg.runId).toBe(runId);
        }
      }

      bridge.broadcastTerminal({ type: 'run_failed', runId, error: 'e', phase: 'p' });
      const failed = messages.filter((m) => m.type === 'run_failed');
      expect(failed[failed.length - 1].runId).toBe(runId);
    });
  });

  // ─── Only snapshot/events/terminal broadcasts ───────────────────────────
  //
  // The bridge emits only snapshot, events, and dedicated terminal lifecycle
  // messages (run_complete / run_failed), all tagged with runId.  Crucially,
  // appending terminal event records (workflow_completed / workflow_failed)
  // must NOT auto-broadcast a terminal signal — that is the RunManager's sole
  // responsibility via broadcastTerminal().

  describe('only snapshot/events/terminal broadcasts', () => {
    const ALLOWED_TYPES = new Set(['snapshot', 'events', 'run_complete', 'run_failed']);

    it('batches event types into events and emits terminal signals only via broadcastTerminal', async () => {
      const { store, bridge, messages, runId, flushMicrotasks } = createSetup();

      // Exercise many event types that used to map to old per-event WS
      // messages.  All of them should now travel inside an events batch.
      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('phase_started', { phaseId: 'scouting', round: 1 }, { phaseId: 'scouting' });
      store.append('task_registered', {
        taskId: 't1',
        phaseId: 'p1',
        title: 'Task 1',
        dependencies: [],
        steps: [],
      });
      store.append('sidebar_updated', { title: 'T', indicator: '🟢' });
      store.append('agent_spawned', { agentId: 'a1', profile: 'scout' }, { agentId: 'a1', phaseId: 'scouting' });
      store.append(
        'turn_ended',
        {
          turn: 1,
          contentBlocks: [{ type: 'text', text: 'Hello' }],
        },
        { agentId: 'a1' },
      );
      // Terminal event records are also batched as ordinary events — they do
      // NOT trigger a dedicated run_complete / run_failed broadcast.  That
      // signal is emitted SOLELY by the RunManager via broadcastTerminal().
      store.append('workflow_completed', { totalDurationMs: 1000, agentCount: 1 });
      store.append('workflow_failed', { error: 'broken', phase: 'test' });

      await flushMicrotasks();

      // Every captured message so far must have a retained type.
      for (const msg of messages) {
        expect(ALLOWED_TYPES.has(msg.type)).toBe(true);
      }
      // Exactly one coalesced events batch carries every appended event.
      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].events).toHaveLength(8);

      // Terminal projection changes must NOT auto-broadcast a terminal
      // signal — that is delegated solely to the RunManager.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);

      // The ONLY way the bridge emits a terminal signal is broadcastTerminal().
      bridge.broadcastTerminal({ type: 'run_complete', runId });
      bridge.broadcastTerminal({ type: 'run_failed', runId, error: 'broken', phase: 'test' });
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(1);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(1);

      // Final guard: still only allowed types were ever emitted.
      for (const msg of messages) {
        expect(ALLOWED_TYPES.has(msg.type)).toBe(true);
      }
    });
  });
});
