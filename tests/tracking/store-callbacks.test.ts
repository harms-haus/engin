import { describe, expect, it } from 'bun:test';
// The event-types shim (packages/engine/src/tracking/event-types.ts) has been
// deleted; types now come straight from @engin/shared/event-types.
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';

// ── Mock EventStore ──────────────────────────────────────────────────────────

interface AppendCall {
  type: EventType;
  data: Record<string, unknown>;
  metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
}

function createMockStore(): {
  store: {
    append: (
      type: EventType,
      data: Record<string, unknown>,
      metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number },
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
        metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number },
      ) {
        calls.push({ type, data, metadata });
        return { seq: calls.length, type, data, metadata: { timestamp: new Date().toISOString(), ...metadata } };
      },
    },
    calls,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createStoreCallbacks', () => {
  describe('onWorkflowStart', () => {
    it('appends workflow_started with correct data', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onWorkflowStart!({ taskPrompt: 'Build it', resumed: true, workDir: '/tmp' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('workflow_started');
      expect(calls[0].data.taskPrompt).toBe('Build it');
      expect(calls[0].data.resumed).toBe(true);
      expect(calls[0].data.workDir).toBe('/tmp');
      expect(calls[0].metadata).toBeUndefined();
    });
  });

  describe('onPhaseRegister', () => {
    it('appends phase_registered with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onPhaseRegister!({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('phase_registered');
      expect(calls[0].data).toEqual({ id: 'scouting', label: 'Scouting', icon: '🔍' });
      expect(calls[0].metadata).toEqual({ phaseId: 'scouting' });
    });
  });

  describe('onPhaseStart', () => {
    it('appends phase_started with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onPhaseStart!({ phase: 'scouting', round: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('phase_started');
      expect(calls[0].data).toEqual({ phase: 'scouting', round: 1 });
      expect(calls[0].metadata).toEqual({ phaseId: 'scouting' });
    });
  });

  describe('onPhaseComplete', () => {
    it('appends phase_completed with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onPhaseComplete!({ phase: 'scouting', durationMs: 1500 });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('phase_completed');
      expect(calls[0].data).toEqual({ phase: 'scouting', durationMs: 1500 });
      expect(calls[0].metadata).toEqual({ phaseId: 'scouting' });
    });
  });

  describe('onTaskRegister', () => {
    it('appends task_registered with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onTaskRegister!({
        taskId: 't1',
        phaseId: 'impl',
        title: 'Build auth',
        dependencies: ['t0'],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('task_registered');
      expect(calls[0].data).toEqual({
        taskId: 't1',
        phaseId: 'impl',
        title: 'Build auth',
        dependencies: ['t0'],
      });
      expect(calls[0].metadata).toEqual({ taskId: 't1', phaseId: 'impl' });
    });
  });

  describe('onSessionStart', () => {
    it('appends agent_spawned with correct data and metadata including stepIndex', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onSessionStart!({
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'impl',
        taskId: 't1',
        sessionId: 'sess-1',
        sessionPath: '/tmp/s',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('session_started');
      expect(calls[0].data.agentId).toBe('a1');
      expect(calls[0].data.profile).toBe('coder');
      expect(calls[0].data.sessionId).toBe('sess-1');
      expect(calls[0].data.sessionPath).toBe('/tmp/s');
      expect(calls[0].metadata).toEqual({ agentId: 'a1', taskId: 't1', phaseId: 'impl' });
    });
  });

  describe('onSessionComplete', () => {
    it('appends agent_completed with correct data and metadata including stepIndex', () => {
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
      expect(calls[0].data.profile).toBe('coder');
      expect(calls[0].data.sessionId).toBe('sess-1');
      expect(calls[0].metadata).toEqual({ agentId: 'a1', taskId: 't1', phaseId: 'impl' });
    });
  });

  describe('onTaskStart', () => {
    it('appends task_started with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onTaskStart!({ taskId: 't1', title: 'Build auth', agentId: 'a1', phaseId: 'impl', startedAt: 1000 });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('task_started');
      expect(calls[0].data.taskId).toBe('t1');
      expect(calls[0].data.title).toBe('Build auth');
      expect(calls[0].data.agentId).toBe('a1');
      expect(calls[0].data.startedAt).toBe(1000);
      expect(calls[0].metadata).toEqual({ agentId: 'a1', taskId: 't1', phaseId: 'impl' });
    });
  });

  describe('onTaskComplete', () => {
    it('appends task_completed with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onTaskComplete!({ taskId: 't1', title: 'Build auth' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('task_completed');
      expect(calls[0].data).toEqual({ taskId: 't1', title: 'Build auth' });
      expect(calls[0].metadata).toEqual({ taskId: 't1' });
    });
  });

  describe('onTaskRejected', () => {
    it('appends task_rejected with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onTaskRejected!({ taskId: 't1', title: 'Build auth', reason: 'Bad code' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('task_rejected');
      expect(calls[0].data).toEqual({ taskId: 't1', title: 'Build auth', reason: 'Bad code' });
      expect(calls[0].metadata).toEqual({ taskId: 't1' });
    });
  });

  describe('onDecision', () => {
    it('appends decision with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onDecision!({ agentId: 'a1', decision: 'Use React', reasoning: 'Best fit', taskId: 't1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('decision');
      expect(calls[0].data).toEqual({ decision: 'Use React', reasoning: 'Best fit' });
      expect(calls[0].metadata).toEqual({ agentId: 'a1', taskId: 't1' });
    });
  });

  describe('onError', () => {
    it('appends error with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onError!({ agentId: 'a1', error: 'Kaboom', phaseId: 'impl', taskId: 't1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('error');
      expect(calls[0].data).toEqual({ error: 'Kaboom' });
      expect(calls[0].metadata).toEqual({ agentId: 'a1', taskId: 't1', phaseId: 'impl' });
    });
  });

  describe('onWorkflowComplete', () => {
    it('appends workflow_completed with correct data', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onWorkflowComplete!({ totalDurationMs: 5000, agentCount: 3 });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('workflow_completed');
      expect(calls[0].data).toEqual({ totalDurationMs: 5000, agentCount: 3 });
      expect(calls[0].metadata).toBeUndefined();
    });
  });

  describe('onWorkflowFailed', () => {
    it('stores error.message as data.error (string) plus structured fields', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      const err = new Error('Kaboom');
      cb.onWorkflowFailed!({ error: err, phaseId: 'impl' });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('workflow_failed');
      expect(calls[0].data.error).toBe('Kaboom');
      expect(calls[0].data.errorName).toBe('Error');
      expect(calls[0].data.phase).toBe('impl');
      expect(calls[0].metadata).toBeUndefined();
    });
  });

  describe('onSidebarUpdate', () => {
    it('appends sidebar_updated with title and indicator only', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onSidebarUpdate!({
        title: 'My Workflow',
        indicator: 'Building…',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('sidebar_updated');
      expect(calls[0].data).toEqual({ title: 'My Workflow', indicator: 'Building…' });
      expect(calls[0].metadata).toBeUndefined();
    });
  });

  describe('onTurnStart', () => {
    it('appends turn_started with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onTurnStart!({ agentId: 'a1', turn: 3 });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('turn_started');
      expect(calls[0].data).toEqual({ turn: 3 });
      expect(calls[0].metadata).toEqual({ agentId: 'a1' });
    });
  });

  describe('onTurnEnd', () => {
    it('appends turn_ended with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      const blocks = [{ type: 'text' as const, text: 'Hello' }];
      cb.onTurnEnd!({ agentId: 'a1', turn: 3, tokens: { input: 100, output: 50 }, contentBlocks: blocks });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('turn_ended');
      expect(calls[0].data.turn).toBe(3);
      expect(calls[0].data.tokens).toEqual({ input: 100, output: 50 });
      expect(calls[0].data.contentBlocks).toEqual(blocks);
      expect(calls[0].metadata).toEqual({ agentId: 'a1' });
    });
  });

  describe('onToolCallStart', () => {
    it('appends tool_call_started with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onToolCallStart!({ agentId: 'a1', toolName: 'bash', toolCallId: 'tc-1', arguments: { command: 'ls' } });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('tool_call_started');
      expect(calls[0].data.toolName).toBe('bash');
      expect(calls[0].data.toolCallId).toBe('tc-1');
      expect(calls[0].data.arguments).toEqual({ command: 'ls' });
      expect(calls[0].metadata).toEqual({ agentId: 'a1' });
    });
  });

  describe('onToolCallEnd', () => {
    it('appends tool_call_ended with correct data and metadata', () => {
      const { store, calls } = createMockStore();
      const cb = createStoreCallbacks(store as never);
      cb.onToolCallEnd!({ agentId: 'a1', toolName: 'bash', toolCallId: 'tc-1', isError: false });
      expect(calls).toHaveLength(1);
      expect(calls[0].type).toBe('tool_call_ended');
      expect(calls[0].data.toolName).toBe('bash');
      expect(calls[0].data.toolCallId).toBe('tc-1');
      expect(calls[0].data.isError).toBe(false);
      expect(calls[0].metadata).toEqual({ agentId: 'a1' });
    });
  });

  describe('all methods are present', () => {
    it('returns an object with all StatusCallbacks methods defined', () => {
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
});

// ── Integration: store-callbacks → EventStore → evolve ──────────────────────

import { beforeEach as beforeIntegration } from 'bun:test';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('store-callbacks → EventStore integration', () => {
  const { getDir } = useTempDir();
  let dir: string;

  beforeIntegration(() => {
    dir = getDir();
  });

  it('onWorkflowFailed sets projection.error to the message string (not [object Object])', () => {
    const store = new EventStore(dir);
    const cb = createStoreCallbacks(store);
    cb.onWorkflowFailed!({ error: new Error('boom'), phaseId: 'review' });
    const proj = store.getProjection();
    expect(proj.status).toBe('failed');
    expect(proj.error).toBe('boom');
    expect(proj.failedPhase).toBe('review');
    // Ensure it is a string, not an object
    expect(typeof proj.error).toBe('string');
  });
});
