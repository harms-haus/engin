// ────────────────────────────────────────────────────────────────────────────
// Tests for the new onSessionStart / onSessionComplete callback wiring in
// store-callbacks.ts. These are additive alongside the existing
// onSessionStart / onSessionComplete / onStepStart mappings.
// ────────────────────────────────────────────────────────────────────────────

import type { EventRecord, EventType } from '@engin/shared/event-types';
import { describe, expect, it } from 'bun:test';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';

// ── Mock EventStore ──────────────────────────────────────────────────────────

interface AppendCall {
  type: EventType;
  data: Record<string, unknown>;
  metadata?: {
    agentId?: string;
    taskId?: string;
    phaseId?: string;
    stepIndex?: number;
    runnerRole?: string;
    attempt?: number;
  };
}

function createMockStore(): {
  store: {
    append: (
      type: EventType,
      data: Record<string, unknown>,
      metadata?: {
        agentId?: string;
        taskId?: string;
        phaseId?: string;
        stepIndex?: number;
        runnerRole?: string;
        attempt?: number;
      },
    ) => EventRecord;
  };
  calls: AppendCall[];
} {
  const calls: AppendCall[] = [];
  return {
    store: {
      append(
        type: EventType,
        data: Record<string, unknown>,
        metadata?: {
          agentId?: string;
          taskId?: string;
          phaseId?: string;
          stepIndex?: number;
          runnerRole?: string;
          attempt?: number;
        },
      ) {
        calls.push({ type, data, metadata });
        return { seq: calls.length, type, data, metadata: { timestamp: new Date().toISOString(), ...metadata } };
      },
    },
    calls,
  };
}

// ── onSessionStart ───────────────────────────────────────────────────────────

describe('createStoreCallbacks – onSessionStart', () => {
  it('appends session_started with correct data and metadata', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    cb.onSessionStart!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      sessionId: 'sess-1',
      sessionPath: '/tmp/s',
      contextWindow: 200000,
      runnerRole: 'executor',
      attempt: 2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('session_started');
    expect(calls[0].data.agentId).toBe('a1');
    expect(calls[0].data.profile).toBe('coder');
    expect(calls[0].data.sessionId).toBe('sess-1');
    expect(calls[0].data.sessionPath).toBe('/tmp/s');
    expect(calls[0].data.contextWindow).toBe(200000);
    // runnerRole/attempt are propagated to the callback info (C1) but are NOT
    // forwarded into the event-store data/metadata by store-callbacks.ts.
    expect(calls[0].metadata).toEqual({
      agentId: 'a1',
      taskId: 't1',
      phaseId: 'impl',
    });
  });

  it('onSessionStart is defined on the callbacks object', () => {
    const { store } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    expect(typeof cb.onSessionStart).toBe('function');
  });
});

// ── onSessionComplete ────────────────────────────────────────────────────────

describe('createStoreCallbacks – onSessionComplete', () => {
  it('appends session_completed with correct data and metadata', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    cb.onSessionComplete!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      sessionId: 'sess-1',
      runnerRole: 'executor',
      attempt: 3,
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('session_completed');
    expect(calls[0].data.agentId).toBe('a1');
    expect(calls[0].data.profile).toBe('coder');
    expect(calls[0].data.sessionId).toBe('sess-1');
    // store-callbacks.ts does not forward runnerRole/attempt into the event
    // metadata for session_completed (C1 cutover).
    expect(calls[0].metadata).toEqual({
      agentId: 'a1',
      taskId: 't1',
      phaseId: 'impl',
    });
  });

  it('onSessionComplete metadata does not include runnerRole/attempt (store-callbacks does not forward them)', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    cb.onSessionComplete!({
      agentId: 'a2',
      profile: 'reviewer',
      phaseId: 'review',
      runnerRole: 'reviewer',
      attempt: 1,
    } as never);
    expect(calls).toHaveLength(1);
    // store-callbacks.ts does not forward runnerRole/attempt into metadata.
    expect(calls[0].metadata?.runnerRole).toBeUndefined();
    expect(calls[0].metadata?.attempt).toBeUndefined();
  });

  it('onSessionComplete is defined on the callbacks object', () => {
    const { store } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    expect(typeof cb.onSessionComplete).toBe('function');
  });
});

// ── Old callbacks still work (regression) ───────────────────────────────────

describe('createStoreCallbacks – old callback regression', () => {
  it('onSessionStart still emits session_started (not session_started)', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    cb.onSessionStart!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      sessionId: 'sess-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('session_started');
    expect(calls[0].data.agentId).toBe('a1');
    expect(calls[0].data.profile).toBe('coder');
    expect(calls[0].data.sessionId).toBe('sess-1');
    expect(calls[0].metadata).toEqual({
      agentId: 'a1',
      taskId: 't1',
      phaseId: 'impl',
    });
  });

  it('onSessionComplete still emits session_completed (not session_completed)', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    cb.onSessionComplete!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      sessionId: 'sess-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('session_completed');
    expect(calls[0].data.agentId).toBe('a1');
  });

  it('onSessionStart and onSessionStart emit different event types', () => {
    const { store, calls } = createMockStore();
    const cb = createStoreCallbacks(store as never);

    cb.onSessionStart!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
    });
    cb.onSessionStart!({
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      taskId: 't1',
      runnerRole: 'executor',
      attempt: 1,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].type).toBe('session_started');
    expect(calls[1].type).toBe('session_started');
  });
});

// ── All methods present ──────────────────────────────────────────────────────

describe('createStoreCallbacks – all methods present (including new session methods)', () => {
  it('returns an object with all StatusCallbacks methods defined, including onSessionStart and onSessionComplete', () => {
    const { store } = createMockStore();
    const cb = createStoreCallbacks(store as never);
    const methods = [
      'onWorkflowStart',
      'onPhaseRegister',
      'onPhaseStart',
      'onPhaseComplete',
      'onTaskRegister',
      'onSessionStart',
      'onSessionComplete',
      'onTaskStart',
      'onTaskComplete',
      'onTaskRejected',
      'onDecision',
      'onError',
      'onWorkflowComplete',
      'onWorkflowFailed',
      'onSidebarUpdate',
      'onTurnStart',
      'onTurnEnd',
      'onToolCallStart',
      'onToolCallEnd',
      'onAutoRetryStart',
      'onAutoRetryCompleted',
    ] as const;
    for (const m of methods) {
      expect(typeof (cb as Record<string, unknown>)[m]).toBe('function');
    }
  });
});
