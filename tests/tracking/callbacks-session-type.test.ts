// ────────────────────────────────────────────────────────────────────────────
// Type-level tests for the new onSessionStart / onSessionComplete callback
// types in core/types/callbacks.ts. Verifies that WorkflowStatusCallbacks
// accepts the new methods with the expected argument shape.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import type { StatusCallbacks, WorkflowStatusCallbacks } from '../../packages/engine/src/core/types/callbacks.js';

// ── onSessionStart type tests ────────────────────────────────────────────────

describe('WorkflowStatusCallbacks – onSessionStart type', () => {
  it('accepts onSessionStart with all fields', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionStart(info) {
        // Verify the info shape at the type level
        const _agentId: string = info.agentId;
        const _profile: string = info.profile;
        const _phaseId: string = info.phaseId;
        const _taskId: string | undefined = info.taskId;
        const _sessionId: string | undefined = info.sessionId;
        const _sessionPath: string | undefined = info.sessionPath;
        const _contextWindow: number | undefined = info.contextWindow;
        const _runnerRole: string | undefined = info.runnerRole;
        const _attempt: number | undefined = info.attempt;
        void _agentId;
        void _profile;
        void _phaseId;
        void _taskId;
        void _sessionId;
        void _sessionPath;
        void _contextWindow;
        void _runnerRole;
        void _attempt;
      },
    };
    expect(typeof cb.onSessionStart).toBe('function');
  });

  it('accepts onSessionStart with only required fields', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionStart(info) {
        // Only required fields used
        void info.agentId;
        void info.profile;
        void info.phaseId;
      },
    };
    expect(typeof cb.onSessionStart).toBe('function');
  });

  it('runnerRole and attempt are optional on the info argument', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionStart(info) {
        // These should be optional — no error when accessing them
        if (info.runnerRole !== undefined) {
          const _role: string = info.runnerRole;
          void _role;
        }
        if (info.attempt !== undefined) {
          const _attempt: number = info.attempt;
          void _attempt;
        }
      },
    };
    expect(typeof cb.onSessionStart).toBe('function');
  });
});

// ── onSessionComplete type tests ─────────────────────────────────────────────

describe('WorkflowStatusCallbacks – onSessionComplete type', () => {
  it('accepts onSessionComplete with all fields', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionComplete(info) {
        const _agentId: string = info.agentId;
        const _profile: string = info.profile;
        const _phaseId: string = info.phaseId;
        const _taskId: string | undefined = info.taskId;
        const _sessionId: string | undefined = info.sessionId;
        void _agentId;
        void _profile;
        void _phaseId;
        void _taskId;
        void _sessionId;
      },
    };
    expect(typeof cb.onSessionComplete).toBe('function');
  });

  it('accepts onSessionComplete with only required fields', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionComplete(info) {
        void info.agentId;
        void info.profile;
        void info.phaseId;
      },
    };
    expect(typeof cb.onSessionComplete).toBe('function');
  });
});

// ── StatusCallbacks intersection includes new methods ────────────────────────

describe('StatusCallbacks – includes onSessionStart and onSessionComplete', () => {
  it('accepts a StatusCallbacks object with onSessionStart', () => {
    const cb: StatusCallbacks = {
      onSessionStart(info) {
        void info.agentId;
        void info.runnerRole;
        void info.attempt;
      },
    };
    expect(typeof cb.onSessionStart).toBe('function');
  });

  it('accepts a StatusCallbacks object with onSessionComplete', () => {
    const cb: StatusCallbacks = {
      onSessionComplete(info) {
        void info.agentId;
      },
    };
    expect(typeof cb.onSessionComplete).toBe('function');
  });
});

// ── Regression: old callbacks still accepted ─────────────────────────────────

describe('WorkflowStatusCallbacks – regression: old callbacks still accepted', () => {
  it('onSessionStart is still accepted', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionStart(info) {
        void info.agentId;
        void info.profile;
        void info.phaseId;
      },
    };
    expect(typeof cb.onSessionStart).toBe('function');
  });

  it('onSessionComplete is still accepted', () => {
    const cb: WorkflowStatusCallbacks = {
      onSessionComplete(info) {
        void info.agentId;
        void info.profile;
        void info.phaseId;
      },
    };
    expect(typeof cb.onSessionComplete).toBe('function');
  });

  it('onAutoRetryStart is still accepted', () => {
    const cb: WorkflowStatusCallbacks = {
      onAutoRetryStart(info) {
        void info.agentId;
        void info.attempt;
        void info.maxAttempts;
        void info.delayMs;
      },
    };
    expect(typeof cb.onAutoRetryStart).toBe('function');
  });
});
