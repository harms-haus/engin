// ─── Regression tests for composeStatusCallbacks — session callbacks ────────
//
// Verifies that `composeStatusCallbacks` (core/utils.ts) forwards
// `onSessionStart` and `onSessionComplete` to child callbacks.
//
// BUG PIN: STATUS_CALLBACK_METHODS is missing 'onSessionStart' and
// 'onSessionComplete', so the composed object's corresponding methods are
// undefined. These tests MUST FAIL until the array is fixed.

import { describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks } from './types.js';
import { STATUS_CALLBACK_METHODS } from './types.js';
import { composeStatusCallbacks } from './utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a StatusCallbacks object where every STATUS_CALLBACK_METHOD is a
 * no-op — used as the "second" child (empty callbacks) in composeTests.
 */
function makeNoopCallbacks(): StatusCallbacks {
  return Object.fromEntries(STATUS_CALLBACK_METHODS.map((name) => [name, () => undefined])) as StatusCallbacks;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('composeStatusCallbacks — STATUS_CALLBACK_METHODS coverage', () => {
  it('STATUS_CALLBACK_METHODS includes onSessionStart', () => {
    expect(STATUS_CALLBACK_METHODS).toContain('onSessionStart');
  });

  it('STATUS_CALLBACK_METHODS includes onSessionComplete', () => {
    expect(STATUS_CALLBACK_METHODS).toContain('onSessionComplete');
  });

  it('STATUS_CALLBACK_METHODS length matches the StatusCallbacks interface key count', () => {
    // The StatusCallbacks intersection (WorkflowStatusCallbacks &
    // AgentStatusCallbacks) has exactly 25 optional methods.  Every method
    // must appear in STATUS_CALLBACK_METHODS, and there must be no extras.
    const interfaceKeys: (keyof StatusCallbacks)[] = [
      'onWorkflowStart',
      'onPhaseRegister',
      'onPhaseStart',
      'onPhaseComplete',
      'onSessionStart',
      'onSessionComplete',
      'onTaskStart',
      'onTaskRegister',
      'onTaskComplete',
      'onTaskRejected',
      'onTaskParked',
      'onTaskUnparked',
      'onDecision',
      'onAgentRender',
      'onError',
      'onWorkflowComplete',
      'onWorkflowFailed',
      'onWorkflowData',
      'onSidebarUpdate',
      'onAutoRetryStart',
      'onAutoRetryCompleted',
      'onTurnStart',
      'onTurnEnd',
      'onToolCallStart',
      'onToolCallEnd',
    ];
    expect(STATUS_CALLBACK_METHODS).toHaveLength(interfaceKeys.length);
  });
});

describe('composeStatusCallbacks — forwards onSessionStart', () => {
  it('calls child onSessionStart with the exact info object', () => {
    const childStart = mock(() => undefined);
    const child: StatusCallbacks = { onSessionStart: childStart } as StatusCallbacks;
    const composed = composeStatusCallbacks([child, makeNoopCallbacks()]);

    const info = {
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      worktree: 'none',
      taskId: 't1',
      sessionId: 'sess-1',
      sessionPath: '/tmp/s',
      contextWindow: 200000,
      runnerRole: 'executor',
      attempt: 2,
    };
    composed.onSessionStart!(info);

    expect(childStart).toHaveBeenCalledTimes(1);
    expect(childStart).toHaveBeenCalledWith(info);
  });

  it('composes multiple children — both receive the onSessionStart call', () => {
    const aStart = mock(() => undefined);
    const bStart = mock(() => undefined);
    const a: StatusCallbacks = { onSessionStart: aStart } as StatusCallbacks;
    const b: StatusCallbacks = { onSessionStart: bStart } as StatusCallbacks;
    const composed = composeStatusCallbacks([a, b]);

    const info = { agentId: 'a1', profile: 'coder', phaseId: 'p1' };
    composed.onSessionStart!(info);

    expect(aStart).toHaveBeenCalledTimes(1);
    expect(bStart).toHaveBeenCalledTimes(1);
    expect(aStart).toHaveBeenCalledWith(info);
    expect(bStart).toHaveBeenCalledWith(info);
  });
});

describe('composeStatusCallbacks — forwards onSessionComplete', () => {
  it('calls child onSessionComplete with the exact info object', () => {
    const childComplete = mock(() => undefined);
    const child: StatusCallbacks = { onSessionComplete: childComplete } as StatusCallbacks;
    const composed = composeStatusCallbacks([child, makeNoopCallbacks()]);

    const info = {
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'impl',
      worktree: 'none',
      taskId: 't1',
      sessionId: 'sess-1',
    };
    composed.onSessionComplete!(info);

    expect(childComplete).toHaveBeenCalledTimes(1);
    expect(childComplete).toHaveBeenCalledWith(info);
  });

  it('composes multiple children — both receive the onSessionComplete call', () => {
    const aComplete = mock(() => undefined);
    const bComplete = mock(() => undefined);
    const a: StatusCallbacks = { onSessionComplete: aComplete } as StatusCallbacks;
    const b: StatusCallbacks = { onSessionComplete: bComplete } as StatusCallbacks;
    const composed = composeStatusCallbacks([a, b]);

    const info = { agentId: 'a1', profile: 'coder', phaseId: 'p1' };
    composed.onSessionComplete!(info);

    expect(aComplete).toHaveBeenCalledTimes(1);
    expect(bComplete).toHaveBeenCalledTimes(1);
    expect(aComplete).toHaveBeenCalledWith(info);
    expect(bComplete).toHaveBeenCalledWith(info);
  });
});

describe('composeStatusCallbacks — both session callbacks exist on composed object', () => {
  it('composed object has onSessionStart as a function', () => {
    const composed = composeStatusCallbacks([makeNoopCallbacks()]);
    expect(typeof composed.onSessionStart).toBe('function');
  });

  it('composed object has onSessionComplete as a function', () => {
    const composed = composeStatusCallbacks([makeNoopCallbacks()]);
    expect(typeof composed.onSessionComplete).toBe('function');
  });
});
