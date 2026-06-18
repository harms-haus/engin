// ─── Tests for createStoreCallbacks — agent_spawned contextWindow ───────────
//
// Verifies that the `onAgentSpawn` store-callback fans `contextWindow` from the
// spawn info into the `data` object of the appended `agent_spawned` event, so
// the projection / TUI can render context-window utilization.
//
// These tests are the task's mandated verification: "a test that spawns via
// store-callbacks and asserts the appended agent_spawned event has
// data.contextWindow set to the model's value." They construct a capturing/fake
// store, invoke createStoreCallbacks(store).onAgentSpawn({...contextWindow}),
// and assert the captured `agent_spawned` append received
// data.contextWindow === <that number>.

import type { EventType } from '@engin/shared/event-types';
import { describe, expect, it, mock } from 'bun:test';
import { createStoreCallbacks } from './store-callbacks.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RecordedCall {
  type: EventType;
  data: Record<string, unknown>;
  metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
}

function makeRecordingStore() {
  const calls: RecordedCall[] = [];
  const store = {
    append: mock((type: EventType, data: Record<string, unknown>, metadata?: RecordedCall['metadata']): void => {
      calls.push({ type, data, metadata });
    }),
  };
  return { store, calls };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createStoreCallbacks — onAgentSpawn contextWindow', () => {
  it('appends agent_spawned with data.contextWindow taken from the spawn info', () => {
    const { store, calls } = makeRecordingStore();
    const cbs = createStoreCallbacks(store);

    // Built as a plain object (not an inline literal at the call site) so the
    // optional `contextWindow` field is accepted structurally regardless of
    // whether the onAgentSpawn info type has been widened yet.
    const info = {
      agentId: 'agent-1',
      profile: 'coder',
      phaseId: 'phase-1',
      taskId: 'task-1',
      stepIndex: 0,
      sessionId: 'sess-1',
      sessionPath: '/tmp/sess-1.jsonl',
      contextWindow: 200000,
    };
    cbs.onAgentSpawn?.(info);

    const spawn = calls.find((c) => c.type === 'agent_spawned');
    expect(spawn, 'an agent_spawned event should have been appended').toBeDefined();
    // The exact event-data key the task requires.
    expect(spawn!.data.contextWindow).toBe(200000);
    // Existing fields are preserved alongside the new one.
    expect(spawn!.data.agentId).toBe('agent-1');
    expect(spawn!.data.profile).toBe('coder');
    expect(spawn!.data.sessionId).toBe('sess-1');
    expect(spawn!.data.sessionPath).toBe('/tmp/sess-1.jsonl');
    // Metadata still routed correctly.
    expect(spawn!.metadata?.agentId).toBe('agent-1');
    expect(spawn!.metadata?.phaseId).toBe('phase-1');
    expect(spawn!.metadata?.stepIndex).toBe(0);
  });

  it('uses a single agent_spawned append (no duplication)', () => {
    const { store, calls } = makeRecordingStore();
    const cbs = createStoreCallbacks(store);

    // Plain object variable (not an inline literal) so the optional
    // `contextWindow` field is accepted structurally regardless of whether
    // the onAgentSpawn info type has been widened yet.
    const info = {
      agentId: 'agent-x',
      profile: 'planner',
      phaseId: 'p',
      contextWindow: 8000,
    };
    cbs.onAgentSpawn?.(info);

    const spawns = calls.filter((c) => c.type === 'agent_spawned');
    expect(spawns).toHaveLength(1);
  });

  it('is backward-compatible: omits contextWindow gracefully when not supplied', () => {
    const { store, calls } = makeRecordingStore();
    const cbs = createStoreCallbacks(store);

    // No contextWindow on the info — must not throw and data.contextWindow is
    // simply absent/undefined.
    cbs.onAgentSpawn?.({ agentId: 'agent-2', profile: 'planner', phaseId: 'phase-1' });

    const spawn = calls.find((c) => c.type === 'agent_spawned');
    expect(spawn).toBeDefined();
    expect(spawn!.data.contextWindow).toBeUndefined();
  });
});
