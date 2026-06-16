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

  // ─── Terminal lifecycle broadcasts ─────────────────────────────────────
  //
  // When the projection status transitions to 'complete' or 'failed', the
  // bridge must broadcast a dedicated run_complete / run_failed message
  // IMMEDIATELY (not coalesced into the events batch), tagged with runId, so
  // the web client can surface a status banner without waiting for the event
  // flush.  The coalesced events batch still carries the terminal event
  // records too.

  describe('terminal lifecycle broadcasts', () => {
    it('broadcasts run_failed immediately on status → failed', () => {
      const { store, messages, runId } = createSetup();

      // Synchronous append — the run_failed broadcast must be captured
      // BEFORE any microtask flush.
      store.append('workflow_failed', { error: 'boom', phase: 'testing' });

      const failed = messages.filter((m) => m.type === 'run_failed');
      expect(failed).toHaveLength(1);
      if (failed[0].type === 'run_failed') {
        expect(failed[0].runId).toBe(runId);
        expect(failed[0].error).toBe('boom');
        expect(failed[0].phase).toBe('testing');
      }
    });

    it('broadcasts run_complete immediately on status → complete', () => {
      const { store, messages, runId } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000 });

      const complete = messages.filter((m) => m.type === 'run_complete');
      expect(complete).toHaveLength(1);
      if (complete[0].type === 'run_complete') {
        expect(complete[0].runId).toBe(runId);
      }
    });

    it('does NOT emit legacy workflow_complete / workflow_failed types', () => {
      const { store, messages } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000 });
      store.append('workflow_failed', { error: 'boom', phase: 'testing' });

      // ServerMessage never carries the legacy workflow_complete /
      // workflow_failed types, so compare the discriminator as a string.
      const types = messages.map((m) => m.type as string);
      expect(types.filter((t) => t === 'workflow_complete')).toHaveLength(0);
      expect(types.filter((t) => t === 'workflow_failed')).toHaveLength(0);
    });

    it('broadcasts both terminal signal and coalesced events batch', async () => {
      const { store, messages, runId, flushMicrotasks } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000, agentCount: 1 });

      // Terminal signal should be present immediately (synchronous).
      const complete = messages.filter((m) => m.type === 'run_complete');
      expect(complete).toHaveLength(1);
      expect(complete[0].runId).toBe(runId);

      // The coalesced events batch is still delivered after the microtask flush.
      await flushMicrotasks();
      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].runId).toBe(runId);
      expect(events[0].events[0].type).toBe('workflow_completed');
    });

    it('does not re-broadcast terminal signal on non-lifecycle events', () => {
      const { store, messages } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('sidebar_updated', { title: 'T' });

      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(0);
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
  // After the multi-run refactor the bridge must emit only snapshot, events,
  // and dedicated terminal lifecycle messages (run_complete / run_failed),
  // all tagged with runId.

  describe('only snapshot/events/terminal broadcasts', () => {
    const ALLOWED_TYPES = new Set(['snapshot', 'events', 'run_complete', 'run_failed']);

    it('broadcasts only allowed types for a wide variety of event types', async () => {
      const { store, messages, flushMicrotasks } = createSetup();

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
      store.append('workflow_completed', { totalDurationMs: 1000, agentCount: 1 });
      store.append('workflow_failed', { error: 'broken', phase: 'test' });

      await flushMicrotasks();

      // Every captured message must have a retained type.
      for (const msg of messages) {
        expect(ALLOWED_TYPES.has(msg.type)).toBe(true);
      }
      // At least one events message was broadcast.
      expect(messages.filter((m) => m.type === 'events')).toHaveLength(1);
      // Terminal lifecycle signals were broadcast.
      expect(messages.filter((m) => m.type === 'run_complete')).toHaveLength(1);
      expect(messages.filter((m) => m.type === 'run_failed')).toHaveLength(1);
    });
  });
});
