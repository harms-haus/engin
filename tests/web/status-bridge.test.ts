import { describe, expect, it } from 'bun:test';
import { EventStore } from '../../src/tracking/event-store.ts';
import type { ServerMessage } from '../../src/web/protocol-types.ts';
import { StatusBridge } from '../../src/web/status-bridge.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create an EventStore and StatusBridge with a message collector.
 * Uses a small ring buffer so we can test resync-eviction scenarios easily.
 */
function createSetup(ringBufferSize = 1000) {
  const messages: ServerMessage[] = [];
  const broadcast = (msg: ServerMessage) => {
    messages.push(msg);
  };
  const store = new EventStore('/tmp/bridge-test-' + Math.random().toString(36).slice(2), {
    maxRingBuffer: ringBufferSize,
  });
  const bridge = new StatusBridge(broadcast, store);

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

  return { store, bridge, messages, clear, msgs, count, flushMicrotasks };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StatusBridge', () => {
  // ─── getSnapshot ───────────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns { type: "snapshot", seq, state } from a fresh store', () => {
      const { bridge, store } = createSetup();
      const snapshot = bridge.getSnapshot();
      const storeSnap = store.getSnapshot();
      expect(snapshot.type).toBe('snapshot');
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

    it('reflects store state after workflow_started', () => {
      const { store, bridge } = createSetup();
      store.append('workflow_started', { taskPrompt: 'Implement login page' });
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.taskPrompt).toBe('Implement login page');
      expect(snapshot.seq).toBe(1);
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
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'test' });
      await flushMicrotasks();

      const eventsMsgs = msgs('events');
      expect(eventsMsgs).toHaveLength(1);
      expect(eventsMsgs[0].type).toBe('events');
      expect(eventsMsgs[0].seq).toBe(1);
      expect(eventsMsgs[0].events).toHaveLength(1);
      expect(eventsMsgs[0].events[0].type).toBe('workflow_started');
      expect(eventsMsgs[0].events[0].data.taskPrompt).toBe('test');
    });

    it('forwards raw EventRecords with correct seq', async () => {
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('phase_started', { phaseId: 'scouting', round: 1 }, { phaseId: 'scouting' });
      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
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
      const { store, msgs, flushMicrotasks } = createSetup();
      // Synchronous appends — should produce only one flush
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('sidebar_updated', { title: 'b' });
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' });

      await flushMicrotasks();

      const events = msgs('events');
      expect(events).toHaveLength(1);
      expect(events[0].events).toHaveLength(3);
      expect(events[0].seq).toBe(3);
    });

    it('separates flushes across async ticks', async () => {
      const { store, msgs, flushMicrotasks } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' });
      await flushMicrotasks();

      expect(msgs('events')).toHaveLength(1);

      // Second tick
      store.append('sidebar_updated', { title: 'b' });
      await flushMicrotasks();

      expect(msgs('events')).toHaveLength(2);
      expect(msgs('events')[1].events).toHaveLength(1);
      expect(msgs('events')[1].seq).toBe(2);
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
      const bridge = new StatusBridge((msg) => messages.push(msg), store);

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
      const bridge = new StatusBridge((msg) => messages.push(msg), store);

      // New event after bridge creation
      store.append('sidebar_updated', { title: 'after' });

      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => setTimeout(r, 0));

      const eventsMsgs = messages.filter((m) => m.type === 'events');
      expect(eventsMsgs).toHaveLength(1);
      expect(eventsMsgs[0].events).toHaveLength(1);
      expect(eventsMsgs[0].events[0].type).toBe('sidebar_updated');
      expect(eventsMsgs[0].seq).toBe(2);

      bridge.dispose();
    });

    it('getSnapshot returns full state including pre-bridge events', () => {
      const store = new EventStore('/tmp/bridge-late3-' + Math.random().toString(36).slice(2));
      store.append('workflow_started', { taskPrompt: 'history' });
      store.append('phase_started', { phaseId: 'a', round: 1 }, { phaseId: 'a' });

      const bridge = new StatusBridge(() => {}, store);
      const snapshot = bridge.getSnapshot();
      expect(snapshot.state.taskPrompt).toBe('history');
      expect(snapshot.state.currentPhaseId).toBe('a');
      expect(snapshot.seq).toBe(2);
      bridge.dispose();
    });
  });

  // ─── Resync ───────────────────────────────────────────────────────────────

  describe('handleResync', () => {
    it('returns events catch-up when lastSeq is within ring buffer', () => {
      const { store, bridge } = createSetup();
      store.append('workflow_started', { taskPrompt: 'a' }); // seq 1
      store.append('sidebar_updated', { title: 'b' }); // seq 2
      store.append('phase_started', { phaseId: 'c', round: 1 }, { phaseId: 'c' }); // seq 3

      const msg = bridge.handleResync(1);
      expect(msg.type).toBe('events');
      if (msg.type === 'events') {
        expect(msg.seq).toBe(3);
        // Should get events with seq > 1
        expect(msg.events).toHaveLength(2);
        expect(msg.events[0].type).toBe('sidebar_updated');
        expect(msg.events[1].type).toBe('phase_started');
      }
    });

    it('returns full snapshot when lastSeq is undefined', () => {
      const { store, bridge } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });

      const msg = bridge.handleResync();
      expect(msg.type).toBe('snapshot');
      if (msg.type === 'snapshot') {
        expect(msg.state.taskPrompt).toBe('x');
        expect(msg.seq).toBe(1);
      }
    });

    it('returns full snapshot when gap is evicted from ring buffer', () => {
      const { store, bridge } = createSetup(5); // tiny ring buffer

      // Append 10 events — the first 5 will be evicted
      for (let i = 0; i < 10; i++) {
        store.append('sidebar_updated', { title: `t${i}` });
      }

      // lastSeq=1 should be evicted (oldest in buffer is seq 6)
      const msg = bridge.handleResync(1);
      expect(msg.type).toBe('snapshot');
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
  });

  // ─── Terminal lifecycle broadcasts (C1) ───────────────────────────────
  //
  // When the projection status transitions to 'complete' or 'failed', the
  // bridge must broadcast a dedicated workflow_complete / workflow_failed
  // message IMMEDIATELY (not coalesced into the events batch), so the web
  // client can surface a status banner without waiting for the event flush.
  // The coalesced events batch still carries the terminal event records too.

  describe('terminal lifecycle broadcasts', () => {
    it('broadcasts workflow_failed immediately on status → failed', () => {
      const { store, messages } = createSetup();

      // Synchronous append — the workflow_failed broadcast must be captured
      // BEFORE any microtask flush.
      store.append('workflow_failed', { error: 'boom', phase: 'testing' });

      const failed = messages.filter((m) => m.type === 'workflow_failed');
      expect(failed).toHaveLength(1);
      if (failed[0].type === 'workflow_failed') {
        expect(failed[0].error).toBe('boom');
        expect(failed[0].phase).toBe('testing');
      }
    });

    it('broadcasts workflow_complete immediately on status → complete', () => {
      const { store, messages } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000 });

      const complete = messages.filter((m) => m.type === 'workflow_complete');
      expect(complete).toHaveLength(1);
    });

    it('broadcasts both terminal signal and coalesced events batch', async () => {
      const { store, messages, flushMicrotasks } = createSetup();

      store.append('workflow_completed', { totalDurationMs: 1000, agentCount: 1 });

      // Terminal signal should be present immediately (synchronous).
      const complete = messages.filter((m) => m.type === 'workflow_complete');
      expect(complete).toHaveLength(1);

      // The coalesced events batch is still delivered after the microtask flush.
      await flushMicrotasks();
      const events = messages.filter((m) => m.type === 'events');
      expect(events).toHaveLength(1);
      expect(events[0].events[0].type).toBe('workflow_completed');
    });

    it('does not re-broadcast terminal signal on non-lifecycle events', () => {
      const { store, messages } = createSetup();
      store.append('workflow_started', { taskPrompt: 'x' });
      store.append('sidebar_updated', { title: 'T' });

      expect(messages.filter((m) => m.type === 'workflow_complete')).toHaveLength(0);
      expect(messages.filter((m) => m.type === 'workflow_failed')).toHaveLength(0);
    });
  });

  // ─── Only snapshot/events/terminal broadcasts ───────────────────────────
  //
  // After the snapshot/delta refactor (kb-13–17) the bridge must emit only
  // snapshot, events, and dedicated terminal lifecycle messages
  // (workflow_complete / workflow_failed).  The latter are synthesized by the
  // bridge on terminal status transitions and sent immediately.

  describe('only snapshot/events/terminal broadcasts', () => {
    const ALLOWED_TYPES = new Set(['snapshot', 'events', 'workflow_complete', 'workflow_failed']);

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
      expect(messages.filter((m) => m.type === 'workflow_complete')).toHaveLength(1);
      expect(messages.filter((m) => m.type === 'workflow_failed')).toHaveLength(1);
    });
  });
});
