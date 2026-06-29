// ─── Multi-run WebSocket protocol tests ────────────────────────────────────
//
// Test-first specification for the multi-run protocol described in section 7 of
// server-refactor.prompt.md. The canonical home is
// `packages/shared/src/protocol-types.ts`.
//
// Contract under test:
//
//   interface RunSummary {
//     runId: string;          // == work-directory name, e.g. "1781118746110-develop"
//     cwd: string;
//     workflowName: string;
//     taskPrompt: string;     // may be truncated for display
//     status: 'running' | 'complete' | 'failed';
//     currentPhaseId?: string;
//     startedAt: string;      // ISO 8601
//   }
//
//   ServerMessage  = runs | run_started | snapshot | events | run_complete |
//                    run_failed | log | auth_required | error | worktree_merge_result
//   ClientMessage  = auth | list_runs | start_run | subscribe | unsubscribe |
//                    resync | cancel_run | worktree_action
//
//   NOTE (worktree UX): `start_run` no longer carries a `worktree?: boolean`
//   gate — the worktree is now unconditional for git repos. `worktree_action`
//   actions are `merge | resolve | decline` (the legacy pr/discard/keep are
//   gone). A new `worktree_merge_result` ServerMessage reports the merge outcome.
//
// Key invariants:
//   - Every projection/event/lifecycle message is tagged with `runId`.
//   - The old global `terminate_server` message and unscoped `resync` are GONE.
//   - The old terminal `workflow_complete` / `workflow_failed` become run-scoped
//     `run_complete` / `run_failed`.
//   - `isServerMessage` recognises all ten ServerMessage variants (including
//     `worktree_merge_result`) and rejects the removed legacy ones.

import { describe, expect, it } from 'bun:test';

import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { isServerMessage } from '@engin/shared/protocol-types';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T12:00:00.000Z';

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: '1781118746110-develop',
    cwd: '/home/user/project',
    workflowName: 'develop',
    taskPrompt: 'Build the feature',
    status: 'running',
    startedAt: ISO_NOW,
    ...overrides,
  };
}

function makeMinimalProjection() {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    sessions: {},
    sidebar: { title: '', indicator: '' },
    status: 'running' as const,
    stats: { totalTokens: 0, sessionCount: 0 },
    runLog: [],
  };
}

// ─── RunSummary ─────────────────────────────────────────────────────────────

describe('RunSummary', () => {
  it('has all required fields with correct types', () => {
    const summary: RunSummary = makeRunSummary();
    expect(summary.runId).toBe('1781118746110-develop');
    expect(summary.cwd).toBe('/home/user/project');
    expect(summary.workflowName).toBe('develop');
    expect(summary.taskPrompt).toBe('Build the feature');
    expect(summary.status).toBe('running');
    expect(summary.startedAt).toBe(ISO_NOW);
  });

  it('status is restricted to running | complete | failed', () => {
    const running: RunSummary = makeRunSummary({ status: 'running' });
    const complete: RunSummary = makeRunSummary({ status: 'complete' });
    const failed: RunSummary = makeRunSummary({ status: 'failed' });
    expect([running.status, complete.status, failed.status]).toEqual(['running', 'complete', 'failed']);
  });

  it('currentPhaseId is optional and defaults to undefined', () => {
    const withoutPhase: RunSummary = makeRunSummary();
    expect(withoutPhase.currentPhaseId).toBeUndefined();

    const withPhase: RunSummary = makeRunSummary({ currentPhaseId: 'coding' });
    expect(withPhase.currentPhaseId).toBe('coding');
  });

  it('startedAt is an ISO 8601 string', () => {
    const summary: RunSummary = makeRunSummary();
    // ISO 8601 parses as a valid date.
    expect(new Date(summary.startedAt).toISOString()).toBe(summary.startedAt);
  });

  it('survives JSON.parse(JSON.stringify()) round-trip', () => {
    const summary: RunSummary = makeRunSummary({ currentPhaseId: 'planning' });
    const roundTripped = JSON.parse(JSON.stringify(summary));
    expect(roundTripped).toEqual(summary);
  });

  it('is exported from the canonical module', () => {
    // Compile-time: the `import type { RunSummary }` above resolves. Runtime:
    // constructing a value proves the import resolved to a usable type.
    const summary: RunSummary = makeRunSummary();
    expect(typeof summary.runId).toBe('string');
  });

  it('is reachable via the shared package (@engin/shared/protocol-types)', () => {
    const summary: RunSummary = makeRunSummary();
    expect(summary.runId).toBe('1781118746110-develop');
  });
});

// ─── ServerMessage – every variant carries the documented shape ────────────

describe('ServerMessage – multi-run variants', () => {
  it('runs variant carries a RunSummary array', () => {
    const msg: ServerMessage = {
      type: 'runs',
      runs: [makeRunSummary(), makeRunSummary({ runId: 'run-2', status: 'complete' })],
    };
    expect(msg.type).toBe('runs');
    expect(msg.runs).toHaveLength(2);
    expect(msg.runs[1].runId).toBe('run-2');
  });

  it('runs variant accepts an empty array', () => {
    const msg: ServerMessage = { type: 'runs', runs: [] };
    expect(msg.runs).toHaveLength(0);
  });

  it('run_started variant carries runId and a full summary', () => {
    const summary = makeRunSummary();
    const msg: ServerMessage = { type: 'run_started', runId: summary.runId, summary };
    expect(msg.type).toBe('run_started');
    expect(msg.runId).toBe(summary.runId);
    expect(msg.summary).toBe(summary);
  });

  it('snapshot variant is tagged with runId, seq, and state', () => {
    const msg: ServerMessage = {
      type: 'snapshot',
      runId: 'run-1',
      seq: 10,
      state: makeMinimalProjection(),
    };
    expect(msg.type).toBe('snapshot');
    if (msg.type !== 'snapshot') throw new Error('unreachable');
    expect(msg.runId).toBe('run-1');
    expect(msg.seq).toBe(10);
    expect(msg.state.status).toBe('running');
  });

  it('events variant is tagged with runId, seq, and an EventRecord batch', () => {
    const msg: ServerMessage = {
      type: 'events',
      runId: 'run-1',
      seq: 3,
      events: [
        {
          seq: 3,
          type: 'phase_started',
          data: { phase: 'coding' },
          metadata: { timestamp: ISO_NOW, phaseId: 'coding' },
        },
      ],
    };
    expect(msg.type).toBe('events');
    expect(msg.runId).toBe('run-1');
    expect(msg.seq).toBe(3);
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe('phase_started');
  });

  it('events variant accepts an empty batch', () => {
    const msg: ServerMessage = { type: 'events', runId: 'run-1', seq: 0, events: [] };
    expect(msg.events).toHaveLength(0);
  });

  it('run_complete variant carries only runId', () => {
    const msg: ServerMessage = { type: 'run_complete', runId: 'run-1' };
    expect(msg.type).toBe('run_complete');
    expect(msg.runId).toBe('run-1');
  });

  it('run_failed variant carries runId, error, and phase', () => {
    const msg: ServerMessage = {
      type: 'run_failed',
      runId: 'run-1',
      error: 'something broke',
      phase: 'planning',
    };
    expect(msg.type).toBe('run_failed');
    expect(msg.runId).toBe('run-1');
    expect(msg.error).toBe('something broke');
    expect(msg.phase).toBe('planning');
  });

  it('log variant carries runId, level, message, and timestamp', () => {
    const msg: ServerMessage = {
      type: 'log',
      runId: 'run-1',
      level: 'warn',
      message: 'disk almost full',
      timestamp: ISO_NOW,
    };
    expect(msg.type).toBe('log');
    expect(msg.runId).toBe('run-1');
    expect(msg.level).toBe('warn');
    expect(msg.message).toBe('disk almost full');
    expect(msg.timestamp).toBe(ISO_NOW);
  });

  it('log level is restricted to info | warn | error', () => {
    const info: ServerMessage = {
      type: 'log',
      runId: 'run-1',
      level: 'info',
      message: 'hi',
      timestamp: ISO_NOW,
    };
    const error: ServerMessage = {
      type: 'log',
      runId: 'run-1',
      level: 'error',
      message: 'boom',
      timestamp: ISO_NOW,
    };
    expect([info.level, error.level]).toEqual(['info', 'error']);
  });

  it('auth_required variant has no payload', () => {
    const msg: ServerMessage = { type: 'auth_required' };
    expect(msg.type).toBe('auth_required');
  });

  it('error variant carries code and message', () => {
    const msg: ServerMessage = {
      type: 'error',
      code: 'UNKNOWN_RUN',
      message: 'no such run',
    };
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('UNKNOWN_RUN');
    expect(msg.message).toBe('no such run');
    expect(msg.runId).toBeUndefined();
  });

  it('error variant optionally scopes to a runId', () => {
    const msg: ServerMessage = {
      type: 'error',
      runId: 'run-1',
      code: 'BAD_MESSAGE',
      message: 'malformed payload',
    };
    expect(msg.runId).toBe('run-1');
    expect(msg.code).toBe('BAD_MESSAGE');
  });

  it('worktree_merge_result variant carries runId and an outcome', () => {
    const msg: ServerMessage = {
      type: 'worktree_merge_result',
      runId: 'run-1',
      outcome: 'clean',
    };
    expect(msg.type).toBe('worktree_merge_result');
    expect(msg.runId).toBe('run-1');
    expect(msg.outcome).toBe('clean');
  });

  it('worktree_merge_result outcome is restricted to clean | conflicts | resolved | failed | declined', () => {
    const clean: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome: 'clean' };
    const conflicts: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome: 'conflicts' };
    const resolved: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome: 'resolved' };
    const failed: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome: 'failed' };
    const declined: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome: 'declined' };
    expect([clean.outcome, conflicts.outcome, resolved.outcome, failed.outcome, declined.outcome]).toEqual([
      'clean',
      'conflicts',
      'resolved',
      'failed',
      'declined',
    ]);
  });

  it('worktree_merge_result carries optional cleanupError / worktreePath / branchName', () => {
    const msg: ServerMessage = {
      type: 'worktree_merge_result',
      runId: 'run-1',
      outcome: 'failed',
      cleanupError: 'worktree busy',
      worktreePath: '/repo/.engin/wt/run-1',
      branchName: 'engin/run-1',
    };
    expect(msg.cleanupError).toBe('worktree busy');
    expect(msg.worktreePath).toBe('/repo/.engin/wt/run-1');
    expect(msg.branchName).toBe('engin/run-1');
  });
});

// ─── runId tagging invariant ────────────────────────────────────────────────

describe('ServerMessage – runId tagging invariant', () => {
  it('snapshot, events, run_complete, run_failed, and log all expose runId', () => {
    const runId = 'tagged-run';
    const snapshot: ServerMessage = { type: 'snapshot', runId, seq: 0, state: makeMinimalProjection() };
    const events: ServerMessage = { type: 'events', runId, seq: 0, events: [] };
    const complete: ServerMessage = { type: 'run_complete', runId };
    const failed: ServerMessage = { type: 'run_failed', runId, error: 'e', phase: 'p' };
    const log: ServerMessage = { type: 'log', runId, level: 'info', message: 'm', timestamp: ISO_NOW };
    const started: ServerMessage = { type: 'run_started', runId, summary: makeRunSummary() };

    for (const msg of [snapshot, events, complete, failed, log, started]) {
      expect((msg as { runId: string }).runId).toBe(runId);
    }
  });
});

// ─── Removed old messages are no longer in the unions ──────────────────────

describe('ServerMessage / ClientMessage – removed legacy messages', () => {
  // These are compile-time guarantees. We exercise them by attempting to
  // construct the discriminated object literals; if the old variants were
  // still present the unions would be wider, but the key assertion is that
  // the *new* narrowing produces the expected `runId`/payload shape. The real
  // "removed" guard is the isServerMessage behaviour below.

  it('workflow_complete / workflow_failed are rejected by isServerMessage', () => {
    expect(isServerMessage({ type: 'workflow_complete' })).toBe(false);
    expect(isServerMessage({ type: 'workflow_failed', error: 'e', phase: 'p' })).toBe(false);
  });
});

// ─── ClientMessage – every variant carries the documented shape ────────────

describe('ClientMessage – multi-run variants', () => {
  it('auth variant accepts an optional token', () => {
    const without: ClientMessage = { type: 'auth' };
    const withToken: ClientMessage = { type: 'auth', token: 'secret-token' };
    expect(without.type).toBe('auth');
    expect(withToken.token).toBe('secret-token');
  });

  it('list_runs variant has no payload', () => {
    const msg: ClientMessage = { type: 'list_runs' };
    expect(msg.type).toBe('list_runs');
  });

  it('start_run variant carries the required fields', () => {
    const msg: ClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'Build the feature',
      cwd: '/home/user/project',
    };
    expect(msg.type).toBe('start_run');
    expect(msg.workflowName).toBe('develop');
    expect(msg.taskPrompt).toBe('Build the feature');
    expect(msg.cwd).toBe('/home/user/project');
  });

  it('start_run variant accepts all optional fields (workDir, apiKeys)', () => {
    // NOTE: `worktree?: boolean` was removed — the worktree is now
    // unconditional for git repos, so start_run no longer carries a gate.
    // NOTE: `maxConcurrent` was removed — total concurrency is now owned by
    // each workflow's config (defaultMaxConcurrentSessions).
    const msg: ClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'Build the feature',
      cwd: '/home/user/project',
      workDir: '/tmp/workdir',
      apiKeys: { anthropic: 'sk-xxx', openai: 'sk-yyy' },
    };
    expect(msg.workDir).toBe('/tmp/workdir');
    expect(msg.apiKeys).toEqual({ anthropic: 'sk-xxx', openai: 'sk-yyy' });
  });

  it('apiKeys on start_run is a string→string record', () => {
    const msg: ClientMessage = {
      type: 'start_run',
      workflowName: 'w',
      taskPrompt: 't',
      cwd: '/c',
      apiKeys: { anthropic: 'sk-1' },
    };
    expect(Object.keys(msg.apiKeys as Record<string, string>)).toEqual(['anthropic']);
    expect((msg.apiKeys as Record<string, string>).anthropic).toBe('sk-1');
  });

  it('subscribe variant carries runId', () => {
    const msg: ClientMessage = { type: 'subscribe', runId: 'run-1' };
    expect(msg.type).toBe('subscribe');
    expect(msg.runId).toBe('run-1');
  });

  it('unsubscribe variant carries runId', () => {
    const msg: ClientMessage = { type: 'unsubscribe', runId: 'run-1' };
    expect(msg.type).toBe('unsubscribe');
    expect(msg.runId).toBe('run-1');
  });

  it('resync variant carries runId and an optional lastSeq', () => {
    const without: ClientMessage = { type: 'resync', runId: 'run-1' };
    const withSeq: ClientMessage = { type: 'resync', runId: 'run-1', lastSeq: 42 };
    expect(without.type).toBe('resync');
    expect(without.runId).toBe('run-1');
    expect(withSeq.lastSeq).toBe(42);
  });

  it('cancel_run variant carries runId', () => {
    const msg: ClientMessage = { type: 'cancel_run', runId: 'run-1' };
    expect(msg.type).toBe('cancel_run');
    expect(msg.runId).toBe('run-1');
  });

  it('worktree_action variant carries runId and an action', () => {
    const msg: ClientMessage = { type: 'worktree_action', runId: 'run-1', action: 'merge' };
    expect(msg.type).toBe('worktree_action');
    expect(msg.runId).toBe('run-1');
    expect(msg.action).toBe('merge');
  });

  it('worktree_action action is restricted to merge | resolve | decline', () => {
    const merge: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'merge' };
    const resolve: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'resolve' };
    const decline: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'decline' };
    expect([merge.action, resolve.action, decline.action]).toEqual(['merge', 'resolve', 'decline']);
  });
});

// ─── isServerMessage type guard ─────────────────────────────────────────────

describe('isServerMessage – recognises every new variant', () => {
  // The payload shapes are already validated structurally in the dedicated
  // `ServerMessage – multi-run variants` block; here we only exercise the
  // runtime guard, so the payloads are typed as `unknown` (the guard's input).
  const validVariants: readonly [string, unknown][] = [
    ['runs', { type: 'runs', runs: [] }],
    ['run_started', { type: 'run_started', runId: 'r', summary: makeRunSummary() }],
    ['snapshot', { type: 'snapshot', runId: 'r', seq: 0, state: makeMinimalProjection() }],
    ['events', { type: 'events', runId: 'r', seq: 0, events: [] }],
    ['run_complete', { type: 'run_complete', runId: 'r' }],
    ['run_failed', { type: 'run_failed', runId: 'r', error: 'e', phase: 'p' }],
    ['log', { type: 'log', runId: 'r', level: 'info', message: 'm', timestamp: ISO_NOW }],
    ['auth_required', { type: 'auth_required' }],
    ['error', { type: 'error', code: 'C', message: 'm' }],
    ['worktree_merge_result', { type: 'worktree_merge_result', runId: 'r', outcome: 'clean' }],
  ];
  it.each(validVariants)('returns true for %s', (_label: string, payload: unknown) => {
    expect(isServerMessage(payload)).toBe(true);
  });
});

describe('isServerMessage – rejects invalid payloads', () => {
  it('returns false for null', () => {
    expect(isServerMessage(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isServerMessage(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isServerMessage('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isServerMessage(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isServerMessage([])).toBe(false);
  });

  it('returns false for an object without a type field', () => {
    expect(isServerMessage({ runId: 'r' })).toBe(false);
  });

  it('returns false for an object with a non-string type', () => {
    expect(isServerMessage({ type: 123 })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isServerMessage({})).toBe(false);
  });

  it('returns false for an unknown message type', () => {
    expect(isServerMessage({ type: 'totally_unknown' })).toBe(false);
  });

  it('returns false for the removed workflow_complete type', () => {
    expect(isServerMessage({ type: 'workflow_complete' })).toBe(false);
  });

  it('returns false for the removed workflow_failed type', () => {
    expect(isServerMessage({ type: 'workflow_failed', error: 'e', phase: 'p' })).toBe(false);
  });

  it('narrows the type so payload fields are accessible', () => {
    const payload: unknown = {
      type: 'run_complete',
      runId: 'run-xyz',
    };
    if (isServerMessage(payload)) {
      // After narrowing, the discriminated union exposes runId on this variant.
      expect((payload as { runId: string }).runId).toBe('run-xyz');
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });
});

// ─── Compile-time exhaustiveness: every variant is reachable ───────────────
//
// A switch over `msg.type` with a default that never returns proves the union
// is exactly the set of nine documented variants. If a variant were added or
// removed without updating the tests, the `never` check would surface it.

function assertExhaustiveServer(msg: ServerMessage): string {
  switch (msg.type) {
    case 'runs':
      return `runs:${msg.runs.length}`;
    case 'run_started':
      return `run_started:${msg.runId}`;
    case 'snapshot':
      return `snapshot:${msg.runId}:${msg.seq}`;
    case 'events':
      return `events:${msg.runId}:${msg.seq}`;
    case 'run_complete':
      return `run_complete:${msg.runId}`;
    case 'run_failed':
      return `run_failed:${msg.runId}:${msg.error}`;
    case 'log':
      return `log:${msg.runId}:${msg.level}`;
    case 'auth_required':
      return 'auth_required';
    case 'error':
      return `error:${msg.code}`;
    case 'worktree_merge_result':
      return `worktree_merge_result:${msg.runId}:${msg.outcome}`;
    default: {
      // Exhaustiveness: `msg` is `never` here iff every variant is handled.
      const _exhaustive: never = msg;
      return String(_exhaustive);
    }
  }
}

function assertExhaustiveClient(msg: ClientMessage): string {
  switch (msg.type) {
    case 'auth':
      return `auth:${msg.token ?? ''}`;
    case 'list_runs':
      return 'list_runs';
    case 'start_run':
      return `start_run:${msg.workflowName}`;
    case 'subscribe':
      return `subscribe:${msg.runId}`;
    case 'unsubscribe':
      return `unsubscribe:${msg.runId}`;
    case 'resync':
      return `resync:${msg.runId}:${msg.lastSeq ?? ''}`;
    case 'cancel_run':
      return `cancel_run:${msg.runId}`;
    case 'worktree_action':
      return `worktree_action:${msg.runId}:${msg.action}`;
    default: {
      const _exhaustive: never = msg;
      return String(_exhaustive);
    }
  }
}

describe('compile-time exhaustiveness guards (smoke run)', () => {
  it('server switch covers every variant', () => {
    expect(assertExhaustiveServer({ type: 'run_started', runId: 'r', summary: makeRunSummary() })).toBe(
      'run_started:r',
    );
    expect(assertExhaustiveServer({ type: 'auth_required' })).toBe('auth_required');
  });

  it('client switch covers every variant', () => {
    expect(assertExhaustiveClient({ type: 'list_runs' })).toBe('list_runs');
    expect(assertExhaustiveClient({ type: 'worktree_action', runId: 'r', action: 'decline' })).toBe(
      'worktree_action:r:decline',
    );
  });
});

// ─── Serialization round-trip for ServerMessage variants ───────────────────

describe('ServerMessage – JSON round-trip', () => {
  it('run_started round-trips through JSON', () => {
    const msg: ServerMessage = {
      type: 'run_started',
      runId: 'r1',
      summary: makeRunSummary({ currentPhaseId: 'coding' }),
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.summary.status).toBe('running');
  });

  it('log round-trips through JSON', () => {
    const msg: ServerMessage = {
      type: 'log',
      runId: 'r1',
      level: 'error',
      message: 'kaboom',
      timestamp: ISO_NOW,
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('error round-trips with and without runId', () => {
    const withRun: ServerMessage = {
      type: 'error',
      runId: 'r1',
      code: 'C',
      message: 'm',
    };
    const withoutRun: ServerMessage = { type: 'error', code: 'C', message: 'm' };
    expect(JSON.parse(JSON.stringify(withRun))).toEqual(withRun);
    expect(JSON.parse(JSON.stringify(withoutRun))).toEqual(withoutRun);
  });

  it('worktree_merge_result round-trips through JSON (with preserved fields)', () => {
    const msg: ServerMessage = {
      type: 'worktree_merge_result',
      runId: 'r1',
      outcome: 'failed',
      cleanupError: 'worktree busy',
      worktreePath: '/repo/.engin/wt/r1',
      branchName: 'engin/r1',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect(roundTripped.outcome).toBe('failed');
    expect(roundTripped.worktreePath).toBe('/repo/.engin/wt/r1');
  });

  it('worktree_merge_result round-trips with only required fields', () => {
    const msg: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'clean' };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
    expect('cleanupError' in roundTripped).toBe(false);
  });
});
