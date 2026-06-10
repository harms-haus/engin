import { describe, expect, it } from 'bun:test';
import type {
  AgentWindowState,
  ClientMessage,
  LogEntry,
  PhaseDescriptor,
  ServerMessage,
  SidebarInfo,
  WebServerOptions,
  WorkflowSummary,
} from '../../src/web/types.ts';

// ─── PhaseDescriptor ────────────────────────────────────────────────────────

describe('PhaseDescriptor', () => {
  it('serializes and round-trips', () => {
    const phase: PhaseDescriptor = { id: 'plan', label: 'Planning', icon: '📋' };

    const json = JSON.stringify(phase);
    const parsed = JSON.parse(json) as PhaseDescriptor;

    expect(parsed.id).toBe('plan');
    expect(parsed.label).toBe('Planning');
    expect(parsed.icon).toBe('📋');
  });

  it('holds arbitrary id/label/icon combinations', () => {
    const phase: PhaseDescriptor = { id: 'exec', label: 'Execution', icon: '⚡' };
    expect(phase.id).toBe('exec');
    expect(phase.label).toBe('Execution');
    expect(phase.icon).toBe('⚡');
  });
});

// ─── LogEntry ───────────────────────────────────────────────────────────────

describe('LogEntry', () => {
  it('serializes and round-trips with minimal fields', () => {
    const entry: LogEntry = {
      id: 'log-1',
      timestamp: '2026-06-10T12:00:00Z',
      type: 'text',
      content: 'Hello world',
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as LogEntry;

    expect(parsed.id).toBe('log-1');
    expect(parsed.timestamp).toBe('2026-06-10T12:00:00Z');
    expect(parsed.type).toBe('text');
    expect(parsed.content).toBe('Hello world');
    expect(parsed.metadata).toBeUndefined();
  });

  it('serializes and round-trips with metadata', () => {
    const entry: LogEntry = {
      id: 'log-2',
      timestamp: '2026-06-10T12:01:00Z',
      type: 'tool_call',
      content: '{"tool":"read_file","args":{"path":"/tmp/test.txt"}}',
      metadata: { toolName: 'read_file', duration: 123 },
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as LogEntry;

    expect(parsed.id).toBe('log-2');
    expect(parsed.type).toBe('tool_call');
    expect(parsed.metadata).toEqual({ toolName: 'read_file', duration: 123 });
  });

  it('supports all log entry types', () => {
    const types: LogEntry['type'][] = [
      'text',
      'thinking',
      'tool_call',
      'tool_call_start',
      'tool_call_end',
      'decision',
      'error',
    ];

    for (const t of types) {
      const entry: LogEntry = {
        id: `log-${t}`,
        timestamp: '2026-06-10T12:00:00Z',
        type: t,
        content: `test-${t}`,
      };
      expect(entry.type).toBe(t);
    }
  });

  it('metadata is optional and defaults to undefined', () => {
    const entry: LogEntry = {
      id: 'log-3',
      timestamp: '2026-06-10T12:02:00Z',
      type: 'error',
      content: 'Something broke',
    };

    expect(entry.metadata).toBeUndefined();
  });

  it('metadata holds arbitrary key-value pairs', () => {
    const entry: LogEntry = {
      id: 'log-4',
      timestamp: '2026-06-10T12:03:00Z',
      type: 'decision',
      content: 'Approved',
      metadata: { score: 95, reviewedBy: 'Alice', notes: ['good', 'fast'] },
    };

    expect(entry.metadata?.score).toBe(95);
    expect(entry.metadata?.reviewedBy).toBe('Alice');
    expect(entry.metadata?.notes).toEqual(['good', 'fast']);
  });
});

// ─── AgentWindowState ───────────────────────────────────────────────────────

describe('AgentWindowState', () => {
  it('serializes and round-trips with required fields', () => {
    const state: AgentWindowState = {
      agentId: 'agent-1',
      profile: 'coder',
      active: true,
      log: [],
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as AgentWindowState;

    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.profile).toBe('coder');
    expect(parsed.active).toBe(true);
    expect(parsed.log).toEqual([]);
    expect(parsed.taskId).toBeUndefined();
  });

  it('includes taskId when set', () => {
    const state: AgentWindowState = {
      agentId: 'agent-2',
      profile: 'scout',
      taskId: 'task-42',
      active: false,
      log: [],
    };

    expect(state.taskId).toBe('task-42');
  });

  it('holds a populated log array', () => {
    const log: LogEntry[] = [
      { id: 'l1', timestamp: '2026-06-10T12:00:00Z', type: 'text', content: 'Start' },
      { id: 'l2', timestamp: '2026-06-10T12:01:00Z', type: 'thinking', content: 'Hmm...' },
    ];

    const state: AgentWindowState = {
      agentId: 'agent-3',
      profile: 'reviewer',
      active: true,
      log,
    };

    expect(state.log).toHaveLength(2);
    expect(state.log[0].content).toBe('Start');
    expect(state.log[1].type).toBe('thinking');
  });
});

// ─── SidebarInfo ────────────────────────────────────────────────────────────

describe('SidebarInfo', () => {
  it('serializes and round-trips without phases', () => {
    const sidebar: SidebarInfo = {
      title: 'Code Review',
      indicator: 'yellow',
    };

    const json = JSON.stringify(sidebar);
    const parsed = JSON.parse(json) as SidebarInfo;

    expect(parsed.title).toBe('Code Review');
    expect(parsed.indicator).toBe('yellow');
    expect(parsed.phases).toBeUndefined();
  });

  it('serializes and round-trips with phases', () => {
    const sidebar: SidebarInfo = {
      title: 'Feature Implementation',
      indicator: 'green',
      phases: [
        { id: 'plan', label: 'Planning', icon: '📋' },
        { id: 'exec', label: 'Execution', icon: '⚡' },
      ],
    };

    const json = JSON.stringify(sidebar);
    const parsed = JSON.parse(json) as SidebarInfo;

    expect(parsed.title).toBe('Feature Implementation');
    expect(parsed.indicator).toBe('green');
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases![0].id).toBe('plan');
    expect(parsed.phases![1].icon).toBe('⚡');
  });
});

// ─── WorkflowSummary ────────────────────────────────────────────────────────

describe('WorkflowSummary', () => {
  it('serializes and round-trips running workflow', () => {
    const summary: WorkflowSummary = {
      id: 'wf-1',
      workflowName: 'My Workflow',
      status: 'running',
      sidebar: { title: 'Running', indicator: 'blue' },
      startedAt: '2026-06-10T12:00:00Z',
    };

    const json = JSON.stringify(summary);
    const parsed = JSON.parse(json) as WorkflowSummary;

    expect(parsed.id).toBe('wf-1');
    expect(parsed.workflowName).toBe('My Workflow');
    expect(parsed.status).toBe('running');
    expect(parsed.completedAt).toBeUndefined();
  });

  it('serializes and round-trips completed workflow', () => {
    const summary: WorkflowSummary = {
      id: 'wf-2',
      workflowName: 'Completed Workflow',
      status: 'completed',
      sidebar: { title: 'Done', indicator: 'green' },
      startedAt: '2026-06-10T10:00:00Z',
      completedAt: '2026-06-10T10:30:00Z',
    };

    const json = JSON.stringify(summary);
    const parsed = JSON.parse(json) as WorkflowSummary;

    expect(parsed.status).toBe('completed');
    expect(parsed.completedAt).toBe('2026-06-10T10:30:00Z');
  });

  it('serializes and round-trips failed workflow', () => {
    const summary: WorkflowSummary = {
      id: 'wf-3',
      workflowName: 'Failed Workflow',
      status: 'failed',
      sidebar: { title: 'Failed', indicator: 'red' },
      startedAt: '2026-06-10T09:00:00Z',
      completedAt: '2026-06-10T09:05:00Z',
    };

    expect(summary.status).toBe('failed');
  });

  it('supports all three status values', () => {
    const statuses: WorkflowSummary['status'][] = ['running', 'completed', 'failed'];
    for (const s of statuses) {
      const summary: WorkflowSummary = {
        id: `wf-${s}`,
        workflowName: `Test ${s}`,
        status: s,
        sidebar: { title: s, indicator: 'gray' },
        startedAt: '2026-06-10T12:00:00Z',
      };
      expect(summary.status).toBe(s);
    }
  });
});

// ─── ServerMessage (discriminated union) ────────────────────────────────────

describe('ServerMessage', () => {
  it('init message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'init',
      workflows: [
        {
          id: 'wf-1',
          workflowName: 'Test',
          status: 'running',
          sidebar: { title: 'Test', indicator: 'blue' },
          startedAt: '2026-06-10T12:00:00Z',
        },
      ],
    };

    if (msg.type === 'init') {
      expect(msg.workflows).toHaveLength(1);
      expect(msg.workflows[0].workflowName).toBe('Test');
    } else {
      expect.unreachable('Should have narrowed to init');
    }
  });

  it('workflow_started message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'workflow_started',
      summary: {
        id: 'wf-2',
        workflowName: 'New WF',
        status: 'running',
        sidebar: { title: 'Running', indicator: 'blue' },
        startedAt: '2026-06-10T12:00:00Z',
      },
    };

    if (msg.type === 'workflow_started') {
      expect(msg.summary.workflowName).toBe('New WF');
      expect(msg.summary.status).toBe('running');
    } else {
      expect.unreachable('Should have narrowed to workflow_started');
    }
  });

  it('workflow_sidebar message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'workflow_sidebar',
      workflowId: 'wf-42',
      sidebar: { title: 'Updated', indicator: 'green', phases: [{ id: 'p1', label: 'Phase 1', icon: '🔧' }] },
    };

    if (msg.type === 'workflow_sidebar') {
      expect(msg.workflowId).toBe('wf-42');
      expect(msg.sidebar.title).toBe('Updated');
      expect(msg.sidebar.phases).toHaveLength(1);
    } else {
      expect.unreachable('Should have narrowed to workflow_sidebar');
    }
  });

  it('workflow_phase message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'workflow_phase',
      workflowId: 'wf-7',
      phase: 'execution',
      completed: ['plan', 'scout'],
    };

    if (msg.type === 'workflow_phase') {
      expect(msg.workflowId).toBe('wf-7');
      expect(msg.phase).toBe('execution');
      expect(msg.completed).toEqual(['plan', 'scout']);
    } else {
      expect.unreachable('Should have narrowed to workflow_phase');
    }
  });

  it('workflow_complete message narrows by type and carries full summary', () => {
    const msg: ServerMessage = {
      type: 'workflow_complete',
      summary: {
        id: 'wf-8',
        workflowName: 'Done WF',
        status: 'completed',
        sidebar: { title: 'Completed', indicator: 'green' },
        startedAt: '2026-06-10T08:00:00Z',
        completedAt: '2026-06-10T08:45:00Z',
      },
    };

    if (msg.type === 'workflow_complete') {
      expect(msg.summary.status).toBe('completed');
      expect(msg.summary.completedAt).toBe('2026-06-10T08:45:00Z');
    } else {
      expect.unreachable('Should have narrowed to workflow_complete');
    }
  });

  it('workflow_failed message narrows by type and carries error info', () => {
    const msg: ServerMessage = {
      type: 'workflow_failed',
      summary: {
        id: 'wf-9',
        workflowName: 'Failed WF',
        status: 'failed',
        sidebar: { title: 'Failed', indicator: 'red' },
        startedAt: '2026-06-10T07:00:00Z',
        completedAt: '2026-06-10T07:10:00Z',
      },
      error: 'Something went terribly wrong',
      phase: 'execution',
    };

    if (msg.type === 'workflow_failed') {
      expect(msg.summary.status).toBe('failed');
      expect(msg.summary.id).toBe('wf-9');
      expect(msg.error).toBe('Something went terribly wrong');
      expect(msg.phase).toBe('execution');
    } else {
      expect.unreachable('Should have narrowed to workflow_failed');
    }
  });

  it('agent_spawned message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'agent_spawned',
      workflowId: 'wf-10',
      agent: {
        agentId: 'agent-1',
        profile: 'coder',
        active: true,
        log: [],
      },
    };

    if (msg.type === 'agent_spawned') {
      expect(msg.workflowId).toBe('wf-10');
      expect(msg.agent.agentId).toBe('agent-1');
      expect(msg.agent.profile).toBe('coder');
      expect(msg.agent.active).toBe(true);
    } else {
      expect.unreachable('Should have narrowed to agent_spawned');
    }
  });

  it('agent_log message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'agent_log',
      workflowId: 'wf-11',
      agentId: 'agent-2',
      entry: {
        id: 'log-99',
        timestamp: '2026-06-10T12:05:00Z',
        type: 'text',
        content: 'Progress update',
      },
    };

    if (msg.type === 'agent_log') {
      expect(msg.workflowId).toBe('wf-11');
      expect(msg.agentId).toBe('agent-2');
      expect(msg.entry.content).toBe('Progress update');
    } else {
      expect.unreachable('Should have narrowed to agent_log');
    }
  });

  it('agent_complete message narrows by type', () => {
    const msg: ServerMessage = {
      type: 'agent_complete',
      workflowId: 'wf-12',
      agentId: 'agent-3',
    };

    if (msg.type === 'agent_complete') {
      expect(msg.workflowId).toBe('wf-12');
      expect(msg.agentId).toBe('agent-3');
    } else {
      expect.unreachable('Should have narrowed to agent_complete');
    }
  });

  it('discriminates all server message variants', () => {
    const messages: ServerMessage[] = [
      { type: 'init', workflows: [] },
      {
        type: 'workflow_started',
        summary: {
          id: 'wf-1',
          workflowName: 'W1',
          status: 'running',
          sidebar: { title: 'T', indicator: 'b' },
          startedAt: '2026-06-10T12:00:00Z',
        },
      },
      { type: 'workflow_sidebar', workflowId: 'wf-1', sidebar: { title: 'T', indicator: 'b' } },
      { type: 'workflow_phase', workflowId: 'wf-1', phase: 'plan', completed: [] },
      {
        type: 'workflow_complete',
        summary: {
          id: 'wf-1',
          workflowName: 'W1',
          status: 'completed',
          sidebar: { title: 'T', indicator: 'g' },
          startedAt: '2026-06-10T12:00:00Z',
          completedAt: '2026-06-10T13:00:00Z',
        },
      },
      {
        type: 'workflow_failed',
        summary: {
          id: 'wf-1',
          workflowName: 'W1',
          status: 'failed',
          sidebar: { title: 'T', indicator: 'r' },
          startedAt: '2026-06-10T12:00:00Z',
        },
        error: 'err',
        phase: 'exec',
      },
      {
        type: 'agent_spawned',
        workflowId: 'wf-1',
        agent: { agentId: 'a1', profile: 'coder', active: true, log: [] },
      },
      {
        type: 'agent_log',
        workflowId: 'wf-1',
        agentId: 'a1',
        entry: { id: 'l1', timestamp: '2026-06-10T12:00:00Z', type: 'text', content: 'hi' },
      },
      { type: 'agent_complete', workflowId: 'wf-1', agentId: 'a1' },
    ];

    expect(messages).toHaveLength(9);

    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      'init',
      'workflow_started',
      'workflow_sidebar',
      'workflow_phase',
      'workflow_complete',
      'workflow_failed',
      'agent_spawned',
      'agent_log',
      'agent_complete',
    ]);
  });
});

// ─── ClientMessage (discriminated union) ────────────────────────────────────

describe('ClientMessage', () => {
  it('start_workflow message narrows by type', () => {
    const msg: ClientMessage = {
      type: 'start_workflow',
      workflowName: 'dev-workflow',
      taskPrompt: 'Build a login page',
    };

    if (msg.type === 'start_workflow') {
      expect(msg.workflowName).toBe('dev-workflow');
      expect(msg.taskPrompt).toBe('Build a login page');
      expect(msg.maxConcurrent).toBeUndefined();
    } else {
      expect.unreachable('Should have narrowed to start_workflow');
    }
  });

  it('start_workflow includes optional maxConcurrent', () => {
    const msg: ClientMessage = {
      type: 'start_workflow',
      workflowName: 'test',
      taskPrompt: 'do something',
      maxConcurrent: 3,
    };

    if (msg.type === 'start_workflow') {
      expect(msg.maxConcurrent).toBe(3);
    } else {
      expect.unreachable('Should have narrowed to start_workflow');
    }
  });

  it('select_workflow message narrows by type', () => {
    const msg: ClientMessage = { type: 'select_workflow', workflowId: 'wf-abc' };

    if (msg.type === 'select_workflow') {
      expect(msg.workflowId).toBe('wf-abc');
    } else {
      expect.unreachable('Should have narrowed to select_workflow');
    }
  });

  it('cancel_workflow message narrows by type', () => {
    const msg: ClientMessage = { type: 'cancel_workflow', workflowId: 'wf-xyz' };

    if (msg.type === 'cancel_workflow') {
      expect(msg.workflowId).toBe('wf-xyz');
    } else {
      expect.unreachable('Should have narrowed to cancel_workflow');
    }
  });

  it('discriminates all client message variants', () => {
    const messages: ClientMessage[] = [
      { type: 'start_workflow', workflowName: 'W1', taskPrompt: 'Do it' },
      { type: 'select_workflow', workflowId: 'wf-1' },
      { type: 'cancel_workflow', workflowId: 'wf-2' },
    ];

    expect(messages).toHaveLength(3);
    const types = messages.map((m) => m.type);
    expect(types).toEqual(['start_workflow', 'select_workflow', 'cancel_workflow']);
  });
});

// ─── WebServerOptions ───────────────────────────────────────────────────────

describe('WebServerOptions', () => {
  it('serializes and round-trips', () => {
    const opts: WebServerOptions = {
      host: '0.0.0.0',
      port: 8080,
      cwd: '/home/user/project',
    };

    const json = JSON.stringify(opts);
    const parsed = JSON.parse(json) as WebServerOptions;

    expect(parsed.host).toBe('0.0.0.0');
    expect(parsed.port).toBe(8080);
    expect(parsed.cwd).toBe('/home/user/project');
  });

  it('holds all required fields', () => {
    const opts: WebServerOptions = { host: '127.0.0.1', port: 3000, cwd: '/tmp' };
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(3000);
    expect(opts.cwd).toBe('/tmp');
  });

  it('port is a number', () => {
    const opts: WebServerOptions = { host: 'localhost', port: 0, cwd: '.' };
    expect(typeof opts.port).toBe('number');
  });
});
