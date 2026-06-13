// ─── Structural parity test for the two copies of protocol-types.ts ────────
//
// src/web/protocol-types.ts      – server-side (Bun)
// web/src/protocol-types.ts      – client-side (Vite/React)
//
// The client copy includes the comment "Mirror copy – keep in sync" but
// there is no automated guard against divergence.  This file uses TypeScript's
// structural type system to verify at compile time that both ServerMessage
// types (and their shared value types) remain structurally identical.
//
// === How it works ===
//
// 1. Top-level bi-directional assignability functions catch:
//    - A variant added/removed in one side but not the other
//    - A required field added/removed/changed in a variant
//
// 2. A type-level `Equal<X, Y>` utility (using the function-call-signature
//    trick) performs an *exact* structural comparison on each isolated
//    variant.  This catches optional-field divergence that simple
//    assignability would miss (e.g. `{type, a?: string}` vs `{type}`).
//    `assertEqual` calls produce a compile error when the types differ.
//
// 3. Sample objects for every message variant are checked against both type
//    imports and verified to exist at runtime via bun:test.
//
// === Which tools enforce the guard ===
//
// - `bun test`                     → runs the runtime assertions (passes)
// - `bun run build` (tsc)          → compiles src/ (passes)
// - `tsc --noEmit` on this file    → catches divergence via Equal<> checks
// - IDEs (VS Code, etc.)           → show inline errors via Equal<> checks

import { describe, expect, it } from 'bun:test';
import type { ServerMessage as ServerSideMessage } from '../../src/web/protocol-types.ts';
import type { ServerMessage as ClientSideMessage } from '../../web/src/protocol-types.ts';

// ─── Type-level exact equality utility ─────────────────────────────────────
//
// Uses the well-known function-call-signature trick.  Equal<X, Y> resolves to
// `true` iff X and Y are structurally identical (catches extra optional
// fields, different field types, etc.).

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Compile-time assertion that a type-level boolean is `true`.
 * If the type argument resolves to `false`, a compile error results:
 *   "Type 'false' does not satisfy the constraint 'true'."
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- T is a compile-time assertion parameter used at call sites
function assertEqual<T extends true>(_desc?: string): void {}

// ─── 1. Top-level bi-directional assignability ─────────────────────────────

function serverAssignableToClient(_m: ServerSideMessage): ClientSideMessage {
  return _m;
}

function clientAssignableToServer(_m: ClientSideMessage): ServerSideMessage {
  return _m;
}

// ─── 2. Variant-level exact equality via Equal<> ───────────────────────────

// ── init ──
type ServerInit = Extract<ServerSideMessage, { type: 'init' }>;
type ClientInit = Extract<ClientSideMessage, { type: 'init' }>;
assertEqual<Equal<ServerInit, ClientInit>>('init');

// ── workflow_phase ──
type ServerWorkflowPhase = Extract<ServerSideMessage, { type: 'workflow_phase' }>;
type ClientWorkflowPhase = Extract<ClientSideMessage, { type: 'workflow_phase' }>;
assertEqual<Equal<ServerWorkflowPhase, ClientWorkflowPhase>>('workflow_phase');

// ── workflow_complete ──
type ServerWorkflowComplete = Extract<ServerSideMessage, { type: 'workflow_complete' }>;
type ClientWorkflowComplete = Extract<ClientSideMessage, { type: 'workflow_complete' }>;
assertEqual<Equal<ServerWorkflowComplete, ClientWorkflowComplete>>('workflow_complete');

// ── workflow_failed ──
type ServerWorkflowFailed = Extract<ServerSideMessage, { type: 'workflow_failed' }>;
type ClientWorkflowFailed = Extract<ClientSideMessage, { type: 'workflow_failed' }>;
assertEqual<Equal<ServerWorkflowFailed, ClientWorkflowFailed>>('workflow_failed');

// ── agent_spawned ──
type ServerAgentSpawned = Extract<ServerSideMessage, { type: 'agent_spawned' }>;
type ClientAgentSpawned = Extract<ClientSideMessage, { type: 'agent_spawned' }>;
assertEqual<Equal<ServerAgentSpawned, ClientAgentSpawned>>('agent_spawned');

// ── agent_log ──
type ServerAgentLog = Extract<ServerSideMessage, { type: 'agent_log' }>;
type ClientAgentLog = Extract<ClientSideMessage, { type: 'agent_log' }>;
assertEqual<Equal<ServerAgentLog, ClientAgentLog>>('agent_log');

// ── agent_complete ──
type ServerAgentComplete = Extract<ServerSideMessage, { type: 'agent_complete' }>;
type ClientAgentComplete = Extract<ClientSideMessage, { type: 'agent_complete' }>;
assertEqual<Equal<ServerAgentComplete, ClientAgentComplete>>('agent_complete');

// ── agent_stats ──
type ServerAgentStats = Extract<ServerSideMessage, { type: 'agent_stats' }>;
type ClientAgentStats = Extract<ClientSideMessage, { type: 'agent_stats' }>;
assertEqual<Equal<ServerAgentStats, ClientAgentStats>>('agent_stats');

// ── tasks_updated ──
type ServerTasksUpdated = Extract<ServerSideMessage, { type: 'tasks_updated' }>;
type ClientTasksUpdated = Extract<ClientSideMessage, { type: 'tasks_updated' }>;
assertEqual<Equal<ServerTasksUpdated, ClientTasksUpdated>>('tasks_updated');

// ── workflow_sidebar ──
type ServerWorkflowSidebar = Extract<ServerSideMessage, { type: 'workflow_sidebar' }>;
type ClientWorkflowSidebar = Extract<ClientSideMessage, { type: 'workflow_sidebar' }>;
assertEqual<Equal<ServerWorkflowSidebar, ClientWorkflowSidebar>>('workflow_sidebar');

// ─── 3. Sample objects for each variant ────────────────────────────────────
//
// Each sample is checked at compile time via checkVariant (which requires
// assignability to BOTH type imports) and at runtime via bun:test assertions.

/** Accept an object that satisfies *both* ServerMessage type imports. */
function checkVariant<T extends ServerSideMessage & ClientSideMessage>(_obj: T): void {
  // no-op: compile-time check only
}

describe('ServerMessage – variant parity (sample objects)', () => {
  it('init variant', () => {
    const sample = {
      type: 'init',
      currentPhase: 'scouting',
      completedPhases: ['planning'],
      tasks: [{ id: 't1', title: 'Test task', status: 'running' }],
      agents: [
        {
          agentId: 'agent-1',
          profile: 'default',
          taskId: 't-42',
          phase: 'scouting',
          active: true,
          log: [
            {
              id: 'log-1',
              timestamp: new Date().toISOString(),
              type: 'text',
              content: 'hello',
              metadata: { foo: 'bar' },
            },
          ],
        },
      ],
      sidebar: {
        title: 'Engin',
        indicator: '🟢',
        phases: [{ id: 'p1', label: 'Plan', icon: '📋' }],
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('init');
    expect(sample.currentPhase).toBe('scouting');
    expect(sample.completedPhases).toEqual(['planning']);
    expect(sample.agents).toHaveLength(1);
    expect(sample.agents[0].agentId).toBe('agent-1');
  });

  it('workflow_phase variant', () => {
    const sample = {
      type: 'workflow_phase',
      phase: 'executing',
      completed: ['scouting', 'planning'],
      currentPhase: 'executing',
    };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_phase');
    expect(sample.phase).toBe('executing');
  });

  it('workflow_complete variant', () => {
    const sample = { type: 'workflow_complete' };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_complete');
  });

  it('workflow_failed variant', () => {
    const sample = {
      type: 'workflow_failed',
      error: 'Something went wrong',
      phase: 'planning',
    };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_failed');
    expect(sample.error).toBe('Something went wrong');
    expect(sample.phase).toBe('planning');
  });

  it('agent_spawned variant', () => {
    const sample = {
      type: 'agent_spawned',
      agent: {
        agentId: 'agent-2',
        profile: 'coder',
        taskId: 't-42',
        phase: 'coding',
        active: true,
        log: [],
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('agent_spawned');
    expect(sample.agent.agentId).toBe('agent-2');
    expect(sample.agent.profile).toBe('coder');
  });

  it('agent_log variant', () => {
    const sample = {
      type: 'agent_log',
      agentId: 'agent-1',
      entry: {
        id: 'log-1',
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        content: 'Tool output',
        metadata: { key: 'value' },
      },
      taskId: 'task-99',
    };
    checkVariant(sample);
    expect(sample.type).toBe('agent_log');
    expect(sample.entry.type).toBe('tool_call');
    expect(sample.taskId).toBe('task-99');
  });

  it('agent_complete variant', () => {
    const sample = {
      type: 'agent_complete',
      agentId: 'agent-1',
      phase: 'coding',
      taskId: 'task-42',
    };
    checkVariant(sample);
    expect(sample.type).toBe('agent_complete');
    expect(sample.agentId).toBe('agent-1');
    expect(sample.phase).toBe('coding');
  });

  it('agent_stats variant', () => {
    const sample = {
      type: 'agent_stats',
      agentId: 'agent-1',
      toolCallCount: 5,
      inputTokens: 1200,
      outputTokens: 800,
      taskId: 'task-42',
    };
    checkVariant(sample);
    expect(sample.type).toBe('agent_stats');
    expect(sample.toolCallCount).toBe(5);
    expect(sample.inputTokens).toBe(1200);
  });

  it('tasks_updated variant', () => {
    const sample = {
      type: 'tasks_updated',
      tasks: [
        { id: 't1', title: 'Design API', status: 'completed' },
        {
          id: 't2',
          title: 'Implement',
          status: 'running',
          phase: 'coding',
          agentId: 'a1',
          startedAt: Date.now(),
        },
      ],
    };
    checkVariant(sample);
    expect(sample.type).toBe('tasks_updated');
    expect(sample.tasks).toHaveLength(2);
    expect(sample.tasks[0].status).toBe('completed');
  });

  it('workflow_sidebar variant', () => {
    const sample = {
      type: 'workflow_sidebar',
      sidebar: {
        title: 'Engin',
        indicator: '🔵',
        phases: [{ id: 'scouting', label: 'Scouting', icon: '🔍' }],
      },
    };
    checkVariant(sample);
    expect(sample.type).toBe('workflow_sidebar');
    expect(sample.sidebar.title).toBe('Engin');
  });
});

// ─── Shared value types structural check ───────────────────────────────────
//
// Ensure the supporting types (PhaseDescriptor, LogEntry, etc.) are also
// in sync.

import type {
  AgentWindowState,
  LogEntry,
  PhaseDescriptor,
  SidebarInfo,
  TaskInfo,
} from '../../src/web/protocol-types.ts';
import type {
  AgentWindowState as ClientAgentWindowState,
  LogEntry as ClientLogEntry,
  PhaseDescriptor as ClientPhaseDescriptor,
  SidebarInfo as ClientSidebarInfo,
  TaskInfo as ClientTaskInfo,
} from '../../web/src/protocol-types.ts';

assertEqual<Equal<PhaseDescriptor, ClientPhaseDescriptor>>('PhaseDescriptor');
assertEqual<Equal<LogEntry, ClientLogEntry>>('LogEntry');
assertEqual<Equal<AgentWindowState, ClientAgentWindowState>>('AgentWindowState');
assertEqual<Equal<TaskInfo, ClientTaskInfo>>('TaskInfo');
assertEqual<Equal<SidebarInfo, ClientSidebarInfo>>('SidebarInfo');

// Also keep bi-directional assignability as a secondary check.
// These functions will fail to compile if the types are not structurally
// compatible in both directions.

function phaseDescriptorAssignableFromServer(_p: PhaseDescriptor): ClientPhaseDescriptor {
  return _p;
}
function phaseDescriptorAssignableFromClient(_p: ClientPhaseDescriptor): PhaseDescriptor {
  return _p;
}

function logEntryAssignableFromServer(_e: LogEntry): ClientLogEntry {
  return _e;
}
function logEntryAssignableFromClient(_e: ClientLogEntry): LogEntry {
  return _e;
}

function agentWindowStateAssignableFromServer(_a: AgentWindowState): ClientAgentWindowState {
  return _a;
}
function agentWindowStateAssignableFromClient(_a: ClientAgentWindowState): AgentWindowState {
  return _a;
}

function taskInfoAssignableFromServer(_t: TaskInfo): ClientTaskInfo {
  return _t;
}
function taskInfoAssignableFromClient(_t: ClientTaskInfo): TaskInfo {
  return _t;
}

function sidebarInfoAssignableFromServer(_s: SidebarInfo): ClientSidebarInfo {
  return _s;
}
function sidebarInfoAssignableFromClient(_s: ClientSidebarInfo): SidebarInfo {
  return _s;
}

// Suppress "unused variable" warnings so the guards remain active.
// Each function is referenced individually to prevent tree-shaking.
void serverAssignableToClient;
void clientAssignableToServer;
void phaseDescriptorAssignableFromServer;
void phaseDescriptorAssignableFromClient;
void logEntryAssignableFromServer;
void logEntryAssignableFromClient;
void agentWindowStateAssignableFromServer;
void agentWindowStateAssignableFromClient;
void taskInfoAssignableFromServer;
void taskInfoAssignableFromClient;
void sidebarInfoAssignableFromServer;
void sidebarInfoAssignableFromClient;
