import { describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks, TurnContentBlock } from '../../src/core/types.ts';
import { RunRegistry } from '../../src/web/run-registry.ts';
import { createStatusBridge } from '../../src/web/status-bridge.ts';
import type { LogEntry, ServerMessage } from '../../src/web/types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function setup() {
  const registry = new RunRegistry();
  const runId = registry.createRun('Test Workflow');
  const broadcast = mock<(msg: ServerMessage) => void>();
  const bridge = createStatusBridge(runId, registry, broadcast);
  return { registry, runId, broadcast, bridge };
}

/**
 * Assert that broadcast was called once with a message matching the given
 * partial shape.
 */
function expectBroadcast(broadcast: ReturnType<typeof mock>, expected: Partial<ServerMessage>) {
  expect(broadcast).toHaveBeenCalledTimes(1);
  const msg = broadcast.mock.calls[0][0];
  expect(msg).toMatchObject(expected as Record<string, unknown>);
}

/**
 * Assert that broadcast was called N times with messages matching the
 * given array of partial shapes, in order.
 */
function expectBroadcastN(broadcast: ReturnType<typeof mock>, expected: Partial<ServerMessage>[]) {
  expect(broadcast).toHaveBeenCalledTimes(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(broadcast.mock.calls[i][0]).toMatchObject(expected[i] as Record<string, unknown>);
  }
}

// ─── No-op callbacks ────────────────────────────────────────────────────────

describe('no-op callbacks', () => {
  const noOps: (keyof StatusCallbacks)[] = [
    'onWorkflowStart',
    'onWorkflowComplete',
    'onWorkflowFailed',
    'onTaskStart',
    'onTaskComplete',
    'onTaskRejected',
    'onTurnStart',
  ];

  for (const name of noOps) {
    it(`${name} does not broadcast or throw`, () => {
      const { bridge, broadcast } = setup();
      const cb = bridge[name] as (...args: never[]) => void;
      expect(() => cb()).not.toThrow();
      expect(broadcast).not.toHaveBeenCalled();
    });
  }
});

// ─── onPhaseStart ───────────────────────────────────────────────────────────

describe('onPhaseStart', () => {
  it('updates the phase via registry and broadcasts workflow_phase', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onPhaseStart?.({ phase: 'scouting', round: 1 });

    // Registry updated
    const entry = registry.getRun(runId)!;
    expect(entry.currentPhase).toBe('scouting');
    expect(entry.completedPhases).toEqual([]);

    // Broadcast
    expectBroadcast(broadcast, {
      type: 'workflow_phase',
      workflowId: runId,
      phase: 'scouting',
      completed: [],
    });
  });

  it('moves previous phase to completedPhases when called twice', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onPhaseStart?.({ phase: 'planning', round: 1 });
    bridge.onPhaseStart?.({ phase: 'implementing', round: 2 });

    const entry = registry.getRun(runId)!;
    expect(entry.currentPhase).toBe('implementing');
    expect(entry.completedPhases).toEqual(['planning']);

    expectBroadcastN(broadcast, [
      { type: 'workflow_phase', phase: 'planning', completed: [] },
      { type: 'workflow_phase', phase: 'implementing', completed: ['planning'] },
    ]);
  });

  it('broadcast message includes current completedPhases', () => {
    const { registry, runId, broadcast, bridge } = setup();
    // Manually set a completed phase to verify it appears in broadcast
    registry.setPhase(runId, 'scouting');
    broadcast.mockClear();

    bridge.onPhaseStart?.({ phase: 'planning', round: 1 });
    expectBroadcast(broadcast, {
      type: 'workflow_phase',
      phase: 'planning',
      completed: ['scouting'],
    });
  });
});

// ─── onPhaseComplete ────────────────────────────────────────────────────────

describe('onPhaseComplete', () => {
  it('broadcasts workflow_phase without modifying registry', () => {
    const { registry, runId, broadcast, bridge } = setup();
    // Set a phase first so completedPhases is populated
    registry.setPhase(runId, 'scouting');
    broadcast.mockClear();

    bridge.onPhaseComplete?.({ phase: 'scouting', durationMs: 500 });

    // Registry unchanged
    const entry = registry.getRun(runId)!;
    expect(entry.currentPhase).toBe('scouting'); // unchanged by onPhaseComplete

    // Broadcast
    expectBroadcast(broadcast, {
      type: 'workflow_phase',
      workflowId: runId,
      phase: 'scouting',
      completed: [], // setPhase only moves phase on subsequent calls; here currentPhase is 'scouting' but completedPhases is empty because setPhase was called only once
    });
  });

  it('broadcast reflects current completedPhases from registry', () => {
    const { registry, runId, broadcast, bridge } = setup();
    registry.setPhase(runId, 'scouting');
    registry.setPhase(runId, 'planning'); // now completedPhases = ['scouting']
    broadcast.mockClear();

    bridge.onPhaseComplete?.({ phase: 'planning', durationMs: 300 });
    expectBroadcast(broadcast, {
      type: 'workflow_phase',
      phase: 'planning',
      completed: ['scouting'],
    });
  });
});

// ─── onAgentSpawn ───────────────────────────────────────────────────────────

describe('onAgentSpawn', () => {
  it('adds agent to registry and broadcasts agent_spawned', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onAgentSpawn?.({
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'task-42',
    });

    // Registry
    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.agentId).toBe('agent-1');
    expect(agent!.profile).toBe('coder');
    expect(agent!.taskId).toBe('task-42');
    expect(agent!.active).toBe(true);
    expect(agent!.log).toEqual([]);
    expect(agent!.phase).toBe('implementing');

    // Broadcast
    expectBroadcast(broadcast, {
      type: 'agent_spawned',
      workflowId: runId,
      agent: {
        agentId: 'agent-1',
        profile: 'coder',
        taskId: 'task-42',
        active: true,
        log: [],
      },
    });

    // Broadcast also carries phase
    const broadcastMsg = broadcast.mock.calls[0][0];
    expect(broadcastMsg.agent.phase).toBe('implementing');
  });

  it('works without optional taskId', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onAgentSpawn?.({ agentId: 'agent-2', profile: 'debugger', phase: 'scouting' });

    const agent = registry.getRun(runId)!.agents.get('agent-2');
    expect(agent?.taskId).toBeUndefined();
    expect(agent!.phase).toBe('scouting');

    expectBroadcast(broadcast, {
      type: 'agent_spawned',
      agent: { agentId: 'agent-2', taskId: undefined },
    });
  });

  it('propagates phase from callback info into the broadcast agent object', () => {
    const { broadcast, bridge } = setup();
    bridge.onAgentSpawn?.({ agentId: 'agent-3', profile: 'coder', phase: 'implementing' });

    const msg = broadcast.mock.calls[0][0] as ServerMessage & { agent: Record<string, unknown> };
    expect(msg.type).toBe('agent_spawned');
    expect(msg.agent.phase).toBe('implementing');
  });

  it('propagates phase into the agent stored in the registry', () => {
    const { registry, runId, bridge } = setup();
    bridge.onAgentSpawn?.({ agentId: 'agent-4', profile: 'scout', phase: 'planning' });

    const agent = registry.getRun(runId)!.agents.get('agent-4');
    expect(agent!.phase).toBe('planning');
  });

  it('propagates phase field for planning phase', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onAgentSpawn?.({
      agentId: 'agent-5',
      profile: 'planner',
      phase: 'planning',
    });

    // Registry stores phase explicitly
    const agent = registry.getRun(runId)!.agents.get('agent-5');
    expect(agent).toBeDefined();
    expect(agent!.phase).toBe('planning');

    // Broadcast also carries the phase
    const broadcastMsg = broadcast.mock.calls[0][0];
    expect(broadcastMsg.type).toBe('agent_spawned');
    expect(broadcastMsg.agent.phase).toBe('planning');
  });
});

// ─── onAgentComplete ────────────────────────────────────────────────────────

describe('onAgentComplete', () => {
  it('marks agent inactive and broadcasts agent_complete', () => {
    const { registry, runId, broadcast, bridge } = setup();
    // Pre-add an agent
    registry.addAgent(runId, {
      agentId: 'agent-1',
      profile: 'coder',
      active: true,
      log: [],
    });
    broadcast.mockClear();

    bridge.onAgentComplete?.({ agentId: 'agent-1', profile: 'coder', phase: 'implementing' });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent!.active).toBe(false);

    expectBroadcast(broadcast, {
      type: 'agent_complete',
      workflowId: runId,
      agentId: 'agent-1',
    });

    // Phase is present in the agent_complete broadcast
    expect(broadcast.mock.calls[0][0].phase).toBe('implementing');
  });

  it('propagates phase from callback info into the broadcast message', () => {
    const { registry, runId, broadcast, bridge } = setup();
    registry.addAgent(runId, {
      agentId: 'agent-5',
      profile: 'reviewer',
      active: true,
      log: [],
    });
    broadcast.mockClear();

    bridge.onAgentComplete?.({ agentId: 'agent-5', profile: 'reviewer', phase: 'review' });

    const msg = broadcast.mock.calls[0][0] as ServerMessage & { phase?: string };
    expect(msg.type).toBe('agent_complete');
    expect(msg.phase).toBe('review');
  });
});

// ─── onTurnEnd ──────────────────────────────────────────────────────────────

describe('onTurnEnd', () => {
  it('adds log entries and broadcasts for each content block', () => {
    const { registry, runId, broadcast, bridge } = setup();

    const blocks: TurnContentBlock[] = [
      { type: 'text', text: 'Hello world' },
      { type: 'thinking', thinking: 'I think therefore I am', redacted: false },
    ];

    bridge.onTurnEnd?.({
      agentId: 'agent-1',
      turn: 3,
      contentBlocks: blocks,
    });

    // Registry should have the agent auto-created with two log entries
    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.log).toHaveLength(2);

    // First entry: text
    expect(agent!.log[0].type).toBe('text');
    expect(agent!.log[0].content).toBe('Hello world');

    // Second entry: thinking
    expect(agent!.log[1].type).toBe('thinking');
    expect(agent!.log[1].content).toBe('I think therefore I am');

    // Broadcast for each block
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'agent_log',
      workflowId: runId,
      agentId: 'agent-1',
      entry: { type: 'text', content: 'Hello world' },
    });
    expect(broadcast.mock.calls[1][0]).toMatchObject({
      type: 'agent_log',
      workflowId: runId,
      agentId: 'agent-1',
      entry: { type: 'thinking', content: 'I think therefore I am' },
    });
  });

  it('uses [redacted] for redacted thinking blocks', () => {
    const { broadcast, bridge } = setup();
    const blocks: TurnContentBlock[] = [{ type: 'thinking', thinking: 'secret plan', redacted: true }];

    bridge.onTurnEnd?.({ agentId: 'agent-1', turn: 1, contentBlocks: blocks });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const entry = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry.content).toBe('[redacted]');
  });

  it('maps toolCall blocks correctly', () => {
    const { broadcast, bridge } = setup();
    const blocks: TurnContentBlock[] = [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/tmp/x.txt' },
      },
    ];

    bridge.onTurnEnd?.({ agentId: 'agent-1', turn: 2, contentBlocks: blocks });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const entry = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry.type).toBe('tool_call');
    expect(entry.content).toBe('read_file');
    expect(entry.metadata).toEqual({ arguments: { path: '/tmp/x.txt' } });
  });

  it('does nothing when contentBlocks is undefined', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onTurnEnd?.({ agentId: 'agent-1', turn: 1 });

    expect(registry.getRun(runId)!.agents.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does nothing when contentBlocks is empty array', () => {
    const { broadcast, bridge } = setup();
    bridge.onTurnEnd?.({ agentId: 'agent-1', turn: 1, contentBlocks: [] });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('generates unique IDs and timestamps for each entry', () => {
    const { broadcast, bridge } = setup();
    const blocks: TurnContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];

    bridge.onTurnEnd?.({ agentId: 'agent-1', turn: 1, contentBlocks: blocks });

    const entry1 = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    const entry2 = (broadcast.mock.calls[1][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry1.id).not.toBe(entry2.id);
    expect(entry1.timestamp).toBeDefined();
    expect(entry2.timestamp).toBeDefined();
  });
});

// ─── onToolCallStart ────────────────────────────────────────────────────────

describe('onToolCallStart', () => {
  it('adds log entry and broadcasts agent_log', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onToolCallStart?.({
      agentId: 'agent-1',
      toolName: 'write_file',
      toolCallId: 'tc-1',
      arguments: { path: '/tmp/out.txt' },
    });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.log).toHaveLength(1);
    expect(agent!.log[0].type).toBe('tool_call_start');
    expect(agent!.log[0].content).toBe('write_file');
    expect(agent!.log[0].id).toBe('tc-1');

    expectBroadcast(broadcast, {
      type: 'agent_log',
      workflowId: runId,
      agentId: 'agent-1',
      entry: { id: 'tc-1', type: 'tool_call_start', content: 'write_file' },
    });
  });
});

// ─── onToolCallEnd ──────────────────────────────────────────────────────────

describe('onToolCallEnd', () => {
  it('adds log entry and broadcasts agent_log', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onToolCallEnd?.({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-2',
      isError: false,
    });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent!.log).toHaveLength(1);
    expect(agent!.log[0].type).toBe('tool_call_end');
    expect(agent!.log[0].content).toBe('read_file');
    expect(agent!.log[0].id).toBe('tc-2-end');
    expect(agent!.log[0].metadata).toEqual({ isError: false });

    expectBroadcast(broadcast, {
      type: 'agent_log',
      entry: { id: 'tc-2-end', type: 'tool_call_end', content: 'read_file', metadata: { isError: false } },
    });
  });

  it('sets isError true when error occurred', () => {
    const { broadcast, bridge } = setup();
    bridge.onToolCallEnd?.({
      agentId: 'agent-1',
      toolName: 'bad_tool',
      toolCallId: 'tc-3',
      isError: true,
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const entry = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry.metadata).toEqual({ isError: true });
  });
});

// ─── onError ────────────────────────────────────────────────────────────────

describe('onError', () => {
  it('adds error log entry and broadcasts', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onError?.({
      agentId: 'agent-1',
      error: 'Something went wrong',
      phase: 'implementing',
    });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent!.log).toHaveLength(1);
    expect(agent!.log[0].type).toBe('error');
    expect(agent!.log[0].content).toBe('Something went wrong');
    expect(agent!.log[0].metadata).toEqual({ phase: 'implementing' });

    expectBroadcast(broadcast, {
      type: 'agent_log',
      entry: { type: 'error', content: 'Something went wrong', metadata: { phase: 'implementing' } },
    });
  });

  it('generates a UUID for the log entry id', () => {
    const { broadcast, bridge } = setup();
    bridge.onError?.({ agentId: 'a1', error: 'err', phase: 'p1' });
    const entry = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

// ─── onDecision ─────────────────────────────────────────────────────────────

describe('onDecision', () => {
  it('adds decision log entry and broadcasts', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onDecision?.({
      agentId: 'agent-1',
      decision: 'Proceed with plan A',
      reasoning: 'Plan A is more efficient',
      taskId: 'task-1',
    });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent!.log).toHaveLength(1);
    expect(agent!.log[0].type).toBe('decision');
    expect(agent!.log[0].content).toBe('Proceed with plan A');
    expect(agent!.log[0].metadata).toEqual({ reasoning: 'Plan A is more efficient' });

    expectBroadcast(broadcast, {
      type: 'agent_log',
      entry: { type: 'decision', content: 'Proceed with plan A', metadata: { reasoning: 'Plan A is more efficient' } },
    });
  });

  it('generates a UUID for the log entry id', () => {
    const { broadcast, bridge } = setup();
    bridge.onDecision?.({ agentId: 'a1', decision: 'd', reasoning: 'r' });
    const entry = (broadcast.mock.calls[0][0] as ServerMessage & { entry: LogEntry }).entry;
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

// ─── onSidebarUpdate ────────────────────────────────────────────────────────

describe('onSidebarUpdate', () => {
  it('updates registry sidebar and broadcasts workflow_sidebar', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onSidebarUpdate?.({
      title: 'Updated Title',
      indicator: 'green',
      phases: [{ id: 'p1', label: 'Phase 1', icon: '🔵' }],
    });

    const entry = registry.getRun(runId)!;
    expect(entry.sidebar.title).toBe('Updated Title');
    expect(entry.sidebar.indicator).toBe('green');
    expect(entry.sidebar.phases).toEqual([{ id: 'p1', label: 'Phase 1', icon: '🔵' }]);

    expectBroadcast(broadcast, {
      type: 'workflow_sidebar',
      workflowId: runId,
      sidebar: {
        title: 'Updated Title',
        indicator: 'green',
        phases: [{ id: 'p1', label: 'Phase 1', icon: '🔵' }],
      },
    });
  });

  it('merges partial updates (only title)', () => {
    const { registry, runId, broadcast, bridge } = setup();
    bridge.onSidebarUpdate?.({ title: 'Only Title' });

    const entry = registry.getRun(runId)!;
    expect(entry.sidebar.title).toBe('Only Title');
    // indicator and phases unchanged
    expect(entry.sidebar.indicator).toBe('...');

    expectBroadcast(broadcast, {
      type: 'workflow_sidebar',
      sidebar: { title: 'Only Title', indicator: '...' },
    });
  });
});

// ─── Integration: log ordering for turn end + tool calls ────────────────────

describe('integration – combined agent log entries', () => {
  it('preserves ordering across multiple events for the same agent', () => {
    const { registry, runId, broadcast, bridge } = setup();

    bridge.onToolCallStart?.({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      arguments: {},
    });

    bridge.onTurnEnd?.({
      agentId: 'agent-1',
      turn: 1,
      contentBlocks: [{ type: 'text', text: 'Reading file...' }],
    });

    bridge.onToolCallEnd?.({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      isError: false,
    });

    const agent = registry.getRun(runId)!.agents.get('agent-1');
    expect(agent!.log).toHaveLength(3);
    expect(agent!.log[0].type).toBe('tool_call_start');
    expect(agent!.log[1].type).toBe('text');
    expect(agent!.log[2].type).toBe('tool_call_end');

    // Broadcast order matches
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ type: 'agent_log', entry: { type: 'tool_call_start' } });
    expect(broadcast.mock.calls[1][0]).toMatchObject({ type: 'agent_log', entry: { type: 'text' } });
    expect(broadcast.mock.calls[2][0]).toMatchObject({ type: 'agent_log', entry: { type: 'tool_call_end' } });
  });
});
